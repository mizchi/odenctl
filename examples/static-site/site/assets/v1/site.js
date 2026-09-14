document.documentElement.dataset.scriptVersion = "v1";
document.querySelector("button").addEventListener("click", () => {
  document.querySelector("output").textContent = "JavaScript v1 is working";
});
