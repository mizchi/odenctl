document.documentElement.dataset.scriptVersion = "v2";
document.querySelector("button").addEventListener("click", () => {
  document.querySelector("output").textContent = "JavaScript v2 is working";
});
