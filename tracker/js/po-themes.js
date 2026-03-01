/* PO Tracker - Theme Color Switcher */
var poThemes = {
  blue:     { accent: "#58a6ff", hover: "#79c0ff", glow: "rgba(88, 166, 255, 0.15)", bg: "#0a0f1a", bgPanel: "#0c1018", bgInput: "#070b12", border: "#1a2744", borderLight: "#1e2d4a", headerBg: "#060a12" },
  red:      { accent: "#ff6b6b", hover: "#ff9999", glow: "rgba(255, 107, 107, 0.15)", bg: "#1a0a0a", bgPanel: "#180c0c", bgInput: "#120707", border: "#44201e", borderLight: "#4a2522", headerBg: "#120606" },
  orange:   { accent: "#f0883e", hover: "#f4a261", glow: "rgba(240, 136, 62, 0.15)", bg: "#1a120a", bgPanel: "#180f0c", bgInput: "#120b07", border: "#44301e", borderLight: "#4a3622", headerBg: "#120a06" },
  green:    { accent: "#3fb950", hover: "#6fdd8b", glow: "rgba(63, 185, 80, 0.15)",  bg: "#0a1a0d", bgPanel: "#0c180e", bgInput: "#071207", border: "#1a4420", borderLight: "#1e4a24", headerBg: "#061208" },
  yellow:   { accent: "#d29922", hover: "#e3b341", glow: "rgba(210, 153, 34, 0.15)", bg: "#1a150a", bgPanel: "#18120c", bgInput: "#120e07", border: "#44361e", borderLight: "#4a3c22", headerBg: "#120e06" },
  purple:   { accent: "#bc8cff", hover: "#d2a8ff", glow: "rgba(188, 140, 255, 0.15)", bg: "#120a1a", bgPanel: "#100c18", bgInput: "#0b0712", border: "#2e1a44", borderLight: "#34204a", headerBg: "#0a0612" },
  black:    { accent: "#8b949e", hover: "#b1bac4", glow: "rgba(139, 148, 158, 0.12)", bg: "#000000", bgPanel: "#0a0a0a", bgInput: "#050505", border: "#2a2a2a", borderLight: "#333333", headerBg: "#000000" },
  ember:    { accent: "#ff6b6b", hover: "#ff9999", glow: "rgba(255, 107, 107, 0.15)", bg: "#000000", bgPanel: "#0a0505", bgInput: "#050202", border: "#3a1515", borderLight: "#441a1a", headerBg: "#000000" },
  midnight: { accent: "#58a6ff", hover: "#79c0ff", glow: "rgba(88, 166, 255, 0.15)", bg: "#000000", bgPanel: "#050810", bgInput: "#020508", border: "#152040", borderLight: "#1a2848", headerBg: "#000000" }
};

function applyPoTheme(name) {
  var theme = poThemes[name] || poThemes.blue;
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
