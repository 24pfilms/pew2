export const fallbackGlassTokens = {
  control: {
    fill: "rgba(20,21,25,0.72)",
    rim: "rgba(255,255,255,0.36)",
  },
  raised: {
    fill: "rgba(28,30,35,0.82)",
    rim: "rgba(255,255,255,0.42)",
  },
  fillActive: "rgba(255,255,255,0.16)",
  fillPressed: "rgba(255,255,255,0.15)",
  intensity: 55,
} as const;

export const approvalActionColors = {
  allowFill: "#b0b6ff",
  allowText: "#0c0e26",
  rejectFill: "#1c1e23",
  rejectRim: "#9a9ba5",
  rejectText: "#f2f3f7",
} as const;
