import { describe, expect, it } from "vitest";
import { strToU8, zipSync } from "fflate";
import { parse3mf } from "../features/design/DesignWorkspace";

describe("3MF import", () => {
  it("applies model units, component transforms, and build transforms", () => {
    const model = `<?xml version="1.0" encoding="UTF-8"?>
      <model unit="inch" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
        <resources>
          <object id="1" type="model"><mesh><vertices>
            <vertex x="0" y="0" z="0"/><vertex x="1" y="0" z="0"/><vertex x="0" y="1" z="0"/><vertex x="0" y="0" z="1"/>
          </vertices><triangles>
            <triangle v1="0" v2="2" v3="1"/><triangle v1="0" v2="1" v3="3"/><triangle v1="0" v2="3" v3="2"/><triangle v1="1" v2="2" v3="3"/>
          </triangles></mesh></object>
          <object id="2" type="model"><components><component objectid="1" transform="1 0 0 0 1 0 0 0 1 1 0 0"/></components></object>
        </resources>
        <build><item objectid="2" transform="1 0 0 0 1 0 0 0 1 2 0 0"/></build>
      </model>`;
    const archive = zipSync({ "3D/3dmodel.model": strToU8(model) });
    const mesh = parse3mf(archive);
    expect(mesh.vertices[0][0]).toBeCloseTo(76.2);
    expect(mesh.vertices[0].slice(1)).toEqual([0, 0]);
    expect(mesh.centerMm).toEqual(expect.objectContaining({ x: expect.closeTo(88.9), y: expect.closeTo(12.7), z: expect.closeTo(12.7) }));
    expect(mesh.dimensionsMm.x).toBeCloseTo(25.4);
    expect(mesh.dimensionsMm.y).toBeCloseTo(25.4);
    expect(mesh.dimensionsMm.z).toBeCloseTo(25.4);
    expect(mesh.faces).toHaveLength(4);
  });
});
