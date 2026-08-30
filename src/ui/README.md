# @ui

DOM overlays and interface. Reads `@state`, emits navigation events.

## What belongs here

- DOM element creation and management
- Text and button rendering
- Search input handling
- Address display and formatting
- Responsive layout and styling

## What cannot be imported

- `three` — the UI does not reach into the scene
- Type-only imports from `three` are allowed, but runtime use is forbidden

## Imports allowed

- `@state/*` for FSM queries and event emission
- `@worker/*` for search results (optional)
- `@motion/*` for overlay animations
- `@core/*` for address formatting and validation
- Type-only imports from any layer

## What calls @ui

- `@app` for setup and lifecycle
- `@state` for reactive updates (when navigation changes)
