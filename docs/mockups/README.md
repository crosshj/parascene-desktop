# Desktop mockups (from ChatGPT)

Visual **references** from [ChatGPT share](https://chatgpt.com/share/6a56996c-fb70-83ea-a3c0-1bb8b4468f30). See also [PLAN-from-chatgpt.md](../PLAN-from-chatgpt.md).

## Customize — mockups are not specs

These images are directional. We **will customize** them where they fight patterns already in the app (tokens, chrome, typography, auth strip, mode switcher). Prefer adapting layout *ideas* to the existing shell rather than rebuilding the mockups pixel-for-pixel.

Examples of likely drift already:

- App uses IBM Plex + purple accent tokens (`src/styles.css`); mocks lean bluer / more generically “video editor”
- Current chrome is a single compact header (mode switch + avatar / logout), not the mock multi-bar “Parascene Desktop Mockups” frame
- Export / Undo / Render chrome in mocks is aspirational; shell pass stays lean until those features exist
- Library hierarchy (breadcrumb → project → modes) is planned; today modes are always available — evolve toward Library without discarding the working chrome patterns

| File | View |
| --- | --- |
| [director.png](./director.png) | Director — preview, scene list, instruction box (“Direct →”) |
| [editor.png](./editor.png) | Editor — assets / sequences, preview, timeline, assistant |
| [hook.png](./hook.png) | Hook — vertical preview, 9s range, suggestions, publish |
| [library-wireframe.png](./library-wireframe.png) | Library hierarchy + ASCII wireframe (next phase) |
