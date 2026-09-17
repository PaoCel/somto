export function attachCharCounter(input) {
  const max = input.maxLength;
  if (!max || max < 0) return;
  const counter = document.createElement("span");
  counter.className = "char-counter";
  counter.setAttribute("aria-live", "polite");
  input.parentNode.appendChild(counter);
  const update = () => {
    const remaining = max - input.value.length;
    counter.textContent = `${input.value.length}/${max}`;
    counter.classList.toggle("char-counter--warn", remaining < max * 0.1);
  };
  input.addEventListener("input", update);
  update();
}
