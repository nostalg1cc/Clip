import React, { useEffect, useState } from "react";
import ReactDOM from "react-dom/client";
import { FluentProvider, webDarkTheme, webLightTheme } from "@fluentui/react-components";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import App from "./App";

function Root() {
  const [mode, setMode] = useState<"light" | "dark">("dark");

  useEffect(() => {
    invoke<string>("get_theme")
      .then((t) => setMode(t === "light" ? "light" : "dark"))
      .catch(() => {});
    const un = listen<string>("theme-changed", (e) =>
      setMode(e.payload === "light" ? "light" : "dark")
    );
    return () => { un.then((f) => f()); };
  }, []);

  useEffect(() => { document.documentElement.dataset.theme = mode; }, [mode]);

  return (
    <FluentProvider
      theme={mode === "light" ? webLightTheme : webDarkTheme}
      style={{ background: "transparent", height: "100%" }}
    >
      <App />
    </FluentProvider>
  );
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>,
);
