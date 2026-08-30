// Entry point for the application.
// Mounts the canvas and initializes the scene.

const canvas = document.getElementById('canvas');
if (!(canvas instanceof HTMLCanvasElement)) {
  throw new Error('Canvas element not found');
}
