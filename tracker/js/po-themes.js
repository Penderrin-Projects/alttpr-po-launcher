/* PO Tracker - Theme Color Switcher */
// Workbench: one charcoal ground for every theme; the accent is what changes.
// (Same table as the launcher's renderer.js — keep them in step.)
var WB = { bg: "#141517", bgPanel: "#1b1d21", bgInput: "#101113", border: "#26282d", borderLight: "#33363d", headerBg: "#141517" };
var poThemes = {
  amber:  Object.assign({ accent: "#e8a33d", hover: "#f2b95c", glow: "rgba(232, 163, 61, 0.14)" }, WB),
  orange: Object.assign({ accent: "#e07a4a", hover: "#ef9668", glow: "rgba(224, 122, 74, 0.14)" }, WB),
  red:    Object.assign({ accent: "#e0604f", hover: "#ec7f70", glow: "rgba(224, 96, 79, 0.14)" },  WB),
  green:  Object.assign({ accent: "#5cb883", hover: "#7ccb9c", glow: "rgba(92, 184, 131, 0.14)" }, WB),
  teal:   Object.assign({ accent: "#5fb0a5", hover: "#7fc6bc", glow: "rgba(95, 176, 165, 0.14)" }, WB),
  blue:   Object.assign({ accent: "#6ea8e8", hover: "#8cbdf0", glow: "rgba(110, 168, 232, 0.14)" }, WB),
  purple: Object.assign({ accent: "#b391e0", hover: "#c6ace9", glow: "rgba(179, 145, 224, 0.14)" }, WB),
  slate:  Object.assign({ accent: "#c9c4b8", hover: "#dedad0", glow: "rgba(201, 196, 184, 0.12)" }, WB)
};
var poLegacyThemes = { midnight: "amber", black: "slate", ember: "red", yellow: "amber" };

function applyPoTheme(name) {
  name = poLegacyThemes[name] || name;
  var theme = poThemes[name] || poThemes.amber;
  var r = document.documentElement;
  r.style.setProperty("--accent-color", theme.accent);
  r.style.setProperty("--accent-hover", theme.hover);
  r.style.setProperty("--accent-glow", theme.glow);
  r.style.setProperty("--theme-bg", theme.bg);
  r.style.setProperty("--theme-panel", theme.bgPanel);
  r.style.setProperty("--theme-input", theme.bgInput);
  r.style.setProperty("--theme-border", theme.border);
  r.style.setProperty("--theme-border-light", theme.borderLight);
  r.style.setProperty("--theme-header-bg", theme.headerBg);
  localStorage.setItem("poTheme", name);
}

// Auto-apply saved theme on load
(function() {
  var saved = localStorage.getItem("poTheme") || "blue";
  applyPoTheme(saved);
})();
