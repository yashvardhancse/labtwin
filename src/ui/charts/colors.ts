import type { AxisName } from '../../core/machine.ts';

/**
 * Axis identity colours: the first three slots of a categorical palette that
 * passes the colour-blind (CVD) separation checks for all pairs. Used by the
 * charts, the report and the 3D axis triad, always together with a text label.
 */
export const AXIS_COLORS: Record<AxisName, string> = { x: '#2a78d6', y: '#eb6834', z: '#1baf7a' };
