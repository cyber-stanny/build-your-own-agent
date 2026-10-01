import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";

// 不用 StrictMode：dev 下它会双调用 effect → 开两条 WebSocket，对我们这种长连接反而添乱
createRoot(document.getElementById("root")!).render(<App />);
