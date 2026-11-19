import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";
import { startDeploymentReloadMonitor } from "../../deployment-reload";

startDeploymentReloadMonitor();
createRoot(document.getElementById("root")!).render(<App />);
