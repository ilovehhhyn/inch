// Mounts the React root into the page.
import { createRoot } from "react-dom/client";

import { App } from "./app";

const root = document.getElementById("root");
if (root === null) {
  throw new Error("index.html must contain an element with id `root`");
}
createRoot(root).render(<App />);
