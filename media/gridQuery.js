// Query-mode bar: lets the user run custom ORM code whose result fills the existing grid.

/** Switches the grid into custom-query mode: reveals the query bar, hides the filter/count UI, wires Run. */
export function enterQueryMode(post) {
  const input = document.getElementById("queryinput");
  const run = () => post({ code: input.value, type: "runQuery" });
  document.getElementById("querybar").hidden = false;
  document.getElementById("filterbar").hidden = true;
  const count = document.getElementById("count");
  if (count) {
    count.hidden = true;
  }
  document.getElementById("runQuery").addEventListener("click", run);
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      run();
    }
  });
}
