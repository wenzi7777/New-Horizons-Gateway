// The Desktop Visualization's pure helpers (grid transform, centre of
// pressure, 3D interpolation) now live in @nhgw/host so NH Pocket draws the
// same; re-exported here for the renderer.
export {
  COP_OFFSET,
  computeCop,
  computePointsCop,
  interpolateGrid,
  mirrorProfileSensors,
  mirrorValues,
  NO_TRANSFORM,
  SURFACE_INTERPOLATION_STEPS,
  surfaceInterpolationSteps,
  transformGrid,
  transformPinLabels,
  VISUAL_SURFACE_MAX_INTERPOLATED_POINTS,
  formatVector,
  type Cop,
  type GridTransform,
} from '@nhgw/host';
