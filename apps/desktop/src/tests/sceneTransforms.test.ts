import * as THREE from "three";
import { directGestureTransform, scenePositionToThree, sceneRotationToThree, sceneScaleToThree, threePositionToScene, threeRotationToScene, threeScaleToScene } from "../components/visuals";
import { rotateSceneVector } from "../features/design/DesignWorkspace";
import type { SceneObject } from "../types";

const object: SceneObject = {
  id: "mesh",
  name: "Mesh",
  kind: "fixture",
  region: "fixture",
  tool: "T1",
  transform: { position: { x: 12.5, y: -4, z: 8 }, rotation: { x: 15, y: -30, z: 45 }, scale: { x: 20, y: 30, z: 40 } },
  sourceDimensionsMm: { x: 10, y: 15, z: 20 },
  visible: true,
};

describe("scene and Three transform mapping", () => {
  it("round-trips physical positions and rotations", () => {
    const position = new THREE.Vector3(...scenePositionToThree(object.transform.position));
    expect(threePositionToScene(position)).toEqual(object.transform.position);
    const rotation = new THREE.Euler(...sceneRotationToThree(object.transform.rotation));
    expect(threeRotationToScene(rotation)).toEqual(object.transform.rotation);
  });

  it("preserves combined XYZ rotation across the scene-to-Three basis", () => {
    const degrees = object.transform.rotation;
    const sceneVector = new THREE.Vector3(1.1, 2.2, 3.3);
    const expectedScene = sceneVector.clone().applyEuler(new THREE.Euler(
      THREE.MathUtils.degToRad(degrees.x),
      THREE.MathUtils.degToRad(degrees.y),
      THREE.MathUtils.degToRad(degrees.z),
      "XYZ",
    ));
    const expectedThree = new THREE.Vector3(...scenePositionToThree(expectedScene));
    const actualThree = new THREE.Vector3(...scenePositionToThree(sceneVector)).applyEuler(new THREE.Euler(...sceneRotationToThree(degrees), "XYZ"));
    expect(actualThree.distanceTo(expectedThree)).toBeLessThan(1e-6);
  });

  it("uses Three XYZ Euler order for combined-axis grouped rotation", () => {
    const vector = { x: 17.25, y: -8.5, z: 4.75 };
    const rotation = { x: 31, y: -47, z: 63 };
    const expected = new THREE.Vector3(vector.x, vector.y, vector.z).applyEuler(new THREE.Euler(
      THREE.MathUtils.degToRad(rotation.x),
      THREE.MathUtils.degToRad(rotation.y),
      THREE.MathUtils.degToRad(rotation.z),
      "XYZ",
    ));
    const actual = rotateSceneVector(vector, rotation);
    expect(new THREE.Vector3(actual.x, actual.y, actual.z).distanceTo(expected)).toBeLessThan(1e-9);
  });

  it("maps target dimensions to relative mesh scale and back", () => {
    expect(sceneScaleToThree(object)).toEqual([2, 2, 2]);
    expect(threeScaleToScene(object, new THREE.Vector3(2.5, 3, 3.5))).toEqual({ x: 25, y: 52.5, z: 60 });
  });

  it("maps direct rotate gestures to snapped scene rotations", () => {
    expect(directGestureTransform(object.transform, "rotate", 40, -20, true).rotation).toEqual({ x: 30, y: -30, z: 60 });
  });

  it("maps direct scale gestures to uniform snapped physical dimensions", () => {
    expect(directGestureTransform(object.transform, "scale", 40, -20, true).scale).toEqual({ x: 26, y: 39, z: 52 });
  });
});
