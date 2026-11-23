// Mounts the React root into the page.
import { createRoot } from "react-dom/client";

import type { MarginApi } from "../shared/ipc-contract";
import { App } from "./app";

declare global {
  interface Window {
    readonly margin: MarginApi;
  }
}

const root = document.getElementById("root");
if (root === null) {
  throw new Error("index.html must contain an element with id `root`");
}
createRoot(root).render(<App api={window.margin} />);
