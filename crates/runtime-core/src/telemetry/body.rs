use super::Span;
use bytes::Bytes;
use http_body::{Body, Frame, SizeHint};
use std::{
    pin::Pin,
    task::{Context, Poll},
};

/// Finishes once on end-of-body, error, or drop. No buffering or read-ahead.
pub struct TrackedBody<B> {
    inner: B,
    span: Option<Span>,
    bytes: u64,
    status: u16,
}
impl<B: Body<Data = Bytes> + Unpin> TrackedBody<B> {
    pub fn new(inner: B, span: Span, status: u16) -> Self {
        span.http_status(status);
        span.event("response.headers");
        let mut body = Self {
            inner,
            span: Some(span),
            bytes: 0,
            status,
        };
        if body.inner.is_end_stream() {
            body.finish(None);
        }
        body
    }
    fn finish(&mut self, error: Option<&str>) {
        if let Some(span) = self.span.take() {
            span.attribute("http.response.body.size", serde_json::json!(self.bytes));
            span.finish(error.unwrap_or(if self.status >= 500 { "error" } else { "ok" }));
        }
    }
}
impl<B: Body<Data = Bytes> + Unpin> Body for TrackedBody<B> {
    type Data = Bytes;
    type Error = B::Error;
    fn poll_frame(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Bytes>, B::Error>>> {
        let value = Pin::new(&mut self.inner).poll_frame(cx);
        match &value {
            Poll::Ready(Some(Ok(frame))) => {
                if let Some(bytes) = frame.data_ref() {
                    self.bytes = self.bytes.saturating_add(bytes.len() as u64);
                }
                if self.inner.is_end_stream() {
                    self.finish(None);
                }
            }
            Poll::Ready(Some(Err(_))) => self.finish(Some("error")),
            Poll::Ready(None) => self.finish(None),
            _ => {}
        }
        value
    }
    fn is_end_stream(&self) -> bool {
        self.inner.is_end_stream()
    }
    fn size_hint(&self) -> SizeHint {
        self.inner.size_hint()
    }
}
impl<B> Drop for TrackedBody<B> {
    fn drop(&mut self) {
        if let Some(span) = self.span.take() {
            span.attribute("http.response.body.size", serde_json::json!(self.bytes));
            span.finish("cancelled");
        }
    }
}
