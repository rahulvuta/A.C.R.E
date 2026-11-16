import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/components.css";
import "./styles/layout.css";
import "./styles/acre.css";
import "./styles/site.css";
import "./styles/workspace.css";
import "./styles/guided.css";
import "./styles/dashboard.css";
import "./styles/onboarding.css";
import "./styles/phone.css";
import { App } from "./App";
import { trackInputMode } from "./ui/inputMode";
import { startChosenLanguage } from "./i18n/translator";

trackInputMode();
// Card 18: if the grower has chosen a language, what is on screen is translated as it appears.
startChosenLanguage();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// Card 20: after the first visit the app's pages are kept on the device, so it opens on a weak
// or missing connection. Only in the built app; the dev server always loads fresh code.
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    void navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`).catch(() => undefined);
  });
}
