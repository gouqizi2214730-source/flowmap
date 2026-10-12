import { describe, expect, it, vi } from 'vitest';
import { downsampleProgram, heatmapProgram, heatmapProgramReady, releaseHeatmapProgram, renderProgramsReady } from './heatmapProgram';
import { makeFakeGL } from './mockGL';

describe('heatmap shader preparation', () => {
  it('starts both render programs while pending and reuses the downsample program', () => {
    const gl = makeFakeGL();
    const completion = 0x91b1;
    let ready = false;
    vi.spyOn(gl, 'getExtension').mockReturnValue({ COMPLETION_STATUS_KHR: completion });
    vi.spyOn(gl, 'getProgramParameter').mockImplementation((_program, key) => key === completion ? ready : true);
    expect(renderProgramsReady(gl, true)).toBe(false);
    expect(gl.callsOf('linkProgram')).toHaveLength(2);
    ready = true;
    expect(renderProgramsReady(gl, true)).toBe(true);
    expect(downsampleProgram(gl)).toBe(downsampleProgram(gl));
    expect(gl.callsOf('linkProgram')).toHaveLength(2);
    releaseHeatmapProgram(gl, false); // GPU handles already freed after context loss
    expect(gl.callsOf('deleteProgram')).toHaveLength(0);
  });
  it('polls parallel completion without blocking status or uniform queries', () => {
    const gl = makeFakeGL();
    const completion = 0x91b1;
    let ready = false;
    vi.spyOn(gl, 'getExtension').mockReturnValue({ COMPLETION_STATUS_KHR: completion });
    const status = vi.spyOn(gl, 'getProgramParameter').mockImplementation((_program, key) => {
      if (key === completion) return ready;
      if (!ready) throw new Error('blocking query before completion');
      return true;
    });
    const uniforms = vi.spyOn(gl, 'getUniformLocation');
    const shaderStatus = vi.spyOn(gl, 'getShaderParameter');
    expect(heatmapProgramReady(gl)).toBe(false);
    expect(heatmapProgramReady(gl)).toBe(false);
    expect(status.mock.calls.every(([, key]) => key === completion)).toBe(true);
    expect(uniforms).not.toHaveBeenCalled();
    expect(shaderStatus).not.toHaveBeenCalled();
    ready = true;
    expect(heatmapProgramReady(gl)).toBe(true);
    const program = heatmapProgram(gl);
    expect(heatmapProgram(gl)).toBe(program);
    expect(gl.callsOf('linkProgram')).toHaveLength(1);
    releaseHeatmapProgram(gl);
    expect(gl.callsOf('deleteProgram')).toHaveLength(1);
  });

  it('supports drivers without parallel compilation and invalidates a restored context', () => {
    const gl = makeFakeGL();
    expect(heatmapProgramReady(gl)).toBe(true);
    const first = heatmapProgram(gl);
    releaseHeatmapProgram(gl);
    expect(heatmapProgram(gl)).not.toBe(first);
    expect(gl.callsOf('linkProgram')).toHaveLength(2);
    releaseHeatmapProgram(gl);
  });

  it('surfaces link errors and deletes the failed program', () => {
    const gl = makeFakeGL();
    vi.spyOn(gl, 'getProgramParameter').mockReturnValue(false);
    vi.spyOn(gl, 'getProgramInfoLog').mockReturnValue('bad shader');
    expect(() => heatmapProgramReady(gl)).toThrow('bad shader');
    expect(gl.callsOf('deleteProgram')).toHaveLength(1);
  });
});
