# Screenshots

Drop captures here, one per left-nav panel.  Filenames are
referenced from the top-level [`README.md`](../../README.md);
keep them stable.

| File | Captures |
|---|---|
| `stack.png` | The Stack panel mid-`up` — profile checkboxes, env editor, container table, log tail. |
| `cluster.png` | Cluster topology with two active clusters during the autoresearcher demo. |
| `examples.png` | Examples panel showing a verification readout (the green ✅ headline + bullet details card). |
| `manifests.png` | Manifest browser, Roles tab, with `coding_agent_implementer` selected. |
| `ailab.png` | AI Lab auto-detect listing one or more model services with the Wire button. |
| `compliance.png` | Compliance dashboard with a non-empty oversight queue + per-LLM-code violation table. |
| `performance.png` | Performance dashboard mid-run — capability stats populated, drift sparkline visible. |
| `kaiden.png` | Kaiden import panel with detected workspace entries + per-row risk/tools form. |

## Capture conventions

- 1280 × 800 or 1440 × 900 logical pixels — small enough to render
  inline in the README without scaling, large enough that operator
  text stays legible.
- Trim Podman Desktop chrome (window frame, top tabs) to the
  panel's left-nav row + right-side content; keeps focus on the
  ACC surface.
- Dark theme matches the panels' built-in palette.
- PNG, lossless.  Do not commit JPEGs.

Until the captures land the README references resolve to GitHub's
"image not found" placeholder; that's the reminder for whoever
gets to run the demo to drop them in.
