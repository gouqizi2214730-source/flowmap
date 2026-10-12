import { HEATMAP_VERT, HEATMAP_FRAG } from './shaders/heatmap';
import { DOWNSAMPLE_VERT, DOWNSAMPLE_FRAG } from './shaders/downsample';

interface ProgramState {
  program: WebGLProgram;
  parallel: KHR_parallel_shader_compile | null;
  ready: boolean;
}

// One program per renderer context, retained across instrument/grid switches.
const programs = new WeakMap<WebGL2RenderingContext, Map<string, ProgramState>>();

function programReady(gl: WebGL2RenderingContext, kind: string, vert: string, frag: string, wait: boolean): boolean {
  let cache = programs.get(gl);
  if (!cache) { cache = new Map(); programs.set(gl, cache); }
  let state = cache.get(kind);
  if (!state) {
    const parallel = gl.getExtension('KHR_parallel_shader_compile');
    const program = gl.createProgram();
    if (!program) throw new Error('flowmap/heatmap: createProgram returned null');
    for (const [type, source] of [[gl.VERTEX_SHADER, vert], [gl.FRAGMENT_SHADER, frag]] as const) {
      const shader = gl.createShader(type);
      if (!shader) {
        gl.deleteProgram(program);
        throw new Error('flowmap/heatmap: createShader returned null');
      }
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      // Status/log queries here would synchronously wait for compilation.
      gl.attachShader(program, shader);
      gl.deleteShader(shader);
    }
    gl.linkProgram(program);
    state = { program, parallel, ready: false };
    cache.set(kind, state);
  }
  if (state.ready) return true;
  if (!wait && state.parallel && !gl.getProgramParameter(state.program, state.parallel.COMPLETION_STATUS_KHR)) return false;
  if (!gl.getProgramParameter(state.program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(state.program);
    gl.deleteProgram(state.program);
    cache.delete(kind);
    throw new Error(`flowmap/heatmap: program link failed: ${log}`);
  }
  state.ready = true;
  return true;
}

export function heatmapProgramReady(gl: WebGL2RenderingContext, wait = false): boolean {
  return programReady(gl, 'heatmap', HEATMAP_VERT, HEATMAP_FRAG, wait);
}

export function renderProgramsReady(gl: WebGL2RenderingContext, withMips: boolean): boolean {
  const heatmapReady = heatmapProgramReady(gl);
  // Start both links before polling again, even when the heatmap is pending.
  const mipsReady = !withMips || programReady(gl, 'mips', DOWNSAMPLE_VERT, DOWNSAMPLE_FRAG, false);
  return heatmapReady && mipsReady;
}

export function downsampleProgram(gl: WebGL2RenderingContext): WebGLProgram {
  programReady(gl, 'mips', DOWNSAMPLE_VERT, DOWNSAMPLE_FRAG, true);
  return programs.get(gl)!.get('mips')!.program;
}

export function heatmapProgram(gl: WebGL2RenderingContext): WebGLProgram {
  // Direct pixel-test/recovery callers retain the synchronous constructor contract.
  // Live ingestion polls readiness before allocating any ring or querying uniforms.
  heatmapProgramReady(gl, true);
  return programs.get(gl)!.get('heatmap')!.program;
}

export function releaseHeatmapProgram(gl: WebGL2RenderingContext, deleteProgram = true): void {
  const cache = programs.get(gl);
  if (cache && deleteProgram) for (const state of cache.values()) gl.deleteProgram(state.program);
  programs.delete(gl);
}
