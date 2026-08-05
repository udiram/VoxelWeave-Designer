import { useCallback, useEffect, useMemo, useRef, useState, type ElementRef, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Canvas, useThree, type ThreeEvent } from "@react-three/fiber";
import { Bounds, OrbitControls, Html, Line, PerspectiveCamera, TransformControls, useBounds } from "@react-three/drei";
import * as THREE from "three";
import type { CropBounds, Orientation, SceneObject, SceneTransformMode, ToolId, Vec3 } from "../types";
import { Icon } from "./icons";
import type { MprPlaneResult, VolumePreviewResult } from "../services/sidecarClient";

const orange = "#b94c23";
const teal = "#18818a";
const ink = "#d7dadd";

function isDomTestRuntime(): boolean {
  return typeof navigator !== "undefined" && /jsdom/i.test(navigator.userAgent);
}

export function SyntheticSlice({ plane, index = 42, onSelect, selected = false }: { plane: Orientation; index?: number; onSelect?: () => void; selected?: boolean }) {
  const labels = plane === "axial" ? { top: "A", bottom: "P", left: "R", right: "L", position: `z: ${(index - 80).toFixed(2)} mm` } : plane === "sagittal" ? { top: "S", bottom: "I", left: "A", right: "P", position: `x: ${(index / 2.1).toFixed(2)} mm` } : { top: "S", bottom: "I", left: "R", right: "L", position: `y: ${(index / -2.1).toFixed(2)} mm` };
  const lungs = plane === "axial" ? "M74 141 C60 102 85 64 145 61 C182 58 210 83 211 121 C210 163 181 194 142 194 C104 194 82 178 74 141ZM426 141 C440 102 415 64 355 61 C318 58 290 83 289 121 C290 163 319 194 358 194 C396 194 418 178 426 141Z" : plane === "sagittal" ? "M182 70 C244 57 299 80 315 137 C322 164 310 193 278 207 C234 225 181 189 168 143 C160 111 161 82 182 70Z" : "M132 82 C168 50 215 58 236 101 C250 128 244 177 212 200 C174 226 127 203 112 163 C101 133 107 103 132 82ZM368 82 C332 50 285 58 264 101 C250 128 256 177 288 200 C326 226 373 203 388 163 C399 133 393 103 368 82Z";
  const ribs = Array.from({ length: 12 }, (_, rib) => {
    const x = 80 + rib * 31;
    return <ellipse key={rib} cx={x} cy={44 + (rib % 2) * 4} rx="14" ry="5" transform={`rotate(${rib % 2 ? -14 : 14} ${x} ${44 + (rib % 2) * 4})`} />;
  });
  return <button type="button" className={`ct-pane ${selected ? "selected" : ""}`} onClick={onSelect} aria-label={`${plane} synthetic CT slice`}>
    <svg viewBox="0 0 500 300" role="img" aria-label={`${plane} preview from full-resolution signed-HU cache`} preserveAspectRatio="none">
      <rect width="500" height="300" fill="#0f1112" />
      <path d="M70 46 C90 27 410 27 430 46 L447 252 C414 275 86 275 53 252Z" fill="#5a5c5d" opacity=".6" />
      <path d={lungs} fill="#151718" stroke="#999b9d" strokeWidth="2.2" />
      <path d="M252 48 C242 98 239 155 250 224" stroke="#bbbdbf" strokeWidth="15" opacity=".76" fill="none" />
      <path d="M252 51 C257 98 264 155 249 222" stroke="#303334" strokeWidth="10" opacity=".9" fill="none" />
      <path d="M73 128 Q252 113 427 128M70 171 Q252 185 430 171" stroke="#848789" strokeWidth="1.4" opacity=".5" fill="none" />
      <g fill="none" stroke="#777a7c" strokeWidth="2" opacity=".7">{ribs}</g>
      <g stroke={orange} strokeWidth="1.15" opacity=".9"><path d="M252 24v252"/><path d="M35 148h430"/></g>
      <text x="12" y="24" fill="#ebedef" fontSize="14" fontWeight="600">{plane[0].toUpperCase() + plane.slice(1)}</text>
      <text x="487" y="24" textAnchor="end" fill="#e6e8e9" fontSize="13">{labels.top}</text>
      <text x="487" y="288" textAnchor="end" fill="#e6e8e9" fontSize="13">{labels.bottom}</text>
      <text x="12" y="158" fill="#e6e8e9" fontSize="13">{labels.left}</text>
      <text x="482" y="158" textAnchor="end" fill="#e6e8e9" fontSize="13">{labels.right}</text>
      <text x="14" y="282" fill="#aeb1b4" fontSize="12">{index} / 150</text>
      <text x="486" y="282" textAnchor="end" fill="#aeb1b4" fontSize="12">{labels.position}</text>
      <text x="486" y="44" textAnchor="end" fill="#aeb1b4" fontSize="11">W: 1600  L: −600</text>
    </svg>
  </button>;
}

function windowLevel(value: number, windowWidth: number, windowCenter: number): number {
  return Math.max(0, Math.min(255, ((value - (windowCenter - windowWidth / 2)) / windowWidth) * 255));
}

async function readBinaryArtifact(path: string): Promise<{ values: Float32Array; shape: number[] }> {
  const raw = await invoke<number[] | Uint8Array>("read_authorized_binary_file", { path });
  const bytes = raw instanceof Uint8Array ? raw : Uint8Array.from(raw);
  if (bytes.length < 10 || String.fromCharCode(...bytes.slice(0, 6)) !== "VWBF\x01\x00") throw new Error("Unsupported VoxelWeave binary artifact");
  const headerLength = new DataView(bytes.buffer, bytes.byteOffset + 6, 4).getUint32(0, false);
  if (headerLength < 1 || 10 + headerLength > bytes.length) throw new Error("VoxelWeave binary header is truncated");
  const header = JSON.parse(new TextDecoder().decode(bytes.slice(10, 10 + headerLength))) as { shape: number[]; dtype: string; payload_bytes?: number };
  const payload = bytes.slice(10 + headerLength);
  if (!header.shape?.length || !header.shape.every((value) => Number.isInteger(value) && value >= 0)) throw new Error("VoxelWeave binary shape is invalid");
  if (header.payload_bytes !== undefined && header.payload_bytes !== payload.byteLength) throw new Error("VoxelWeave binary payload length does not match its header");
  if (header.dtype.startsWith(">")) throw new Error("Big-endian VoxelWeave artifacts are unsupported");
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const descriptor = header.dtype.replace(/^[<>=|]/, "");
  const readers: Record<string, { bytes: number; read: (offset: number) => number }> = {
    f4: { bytes: 4, read: (offset) => view.getFloat32(offset, true) },
    f8: { bytes: 8, read: (offset) => view.getFloat64(offset, true) },
    i1: { bytes: 1, read: (offset) => view.getInt8(offset) },
    u1: { bytes: 1, read: (offset) => view.getUint8(offset) },
    i2: { bytes: 2, read: (offset) => view.getInt16(offset, true) },
    u2: { bytes: 2, read: (offset) => view.getUint16(offset, true) },
    i4: { bytes: 4, read: (offset) => view.getInt32(offset, true) },
    u4: { bytes: 4, read: (offset) => view.getUint32(offset, true) },
  };
  const reader = readers[descriptor];
  if (!reader || payload.byteLength % reader.bytes !== 0) throw new Error(`Unsupported VoxelWeave scalar dtype ${header.dtype}`);
  const itemCount = header.shape.reduce((product, value) => product * value, 1);
  if (itemCount * reader.bytes !== payload.byteLength) throw new Error("VoxelWeave binary payload does not fit its declared shape");
  const values = new Float32Array(itemCount);
  for (let index = 0; index < itemCount; index += 1) values[index] = reader.read(index * reader.bytes);
  return { values, shape: header.shape };
}

export function InteractiveMprPane({ plane, result, selected = false, index, windowWidth = 1600, windowCenter = -600, crosshair: linkedCrosshair, onSelect, onCrosshair, onWindowLevel, onSliceChange, testAdapter = false }: { plane: Orientation; result?: MprPlaneResult; selected?: boolean; index: number; windowWidth?: number; windowCenter?: number; crosshair?: { x: number; y: number }; onSelect?: () => void; onCrosshair?: (x: number, y: number) => void; onWindowLevel?: (width: number, center: number) => void; onSliceChange?: (delta: number) => void; testAdapter?: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [error, setError] = useState<string>();
  const [windowing, setWindowing] = useState({ width: windowWidth, center: windowCenter });
  const [crosshair, setCrosshair] = useState({ x: 0.5, y: 0.5 });
  const [sampleHu, setSampleHu] = useState(-1024);
  const [view, setView] = useState({ zoom: 1, panX: 0, panY: 0 });
  const valuesRef = useRef<Float32Array | undefined>(undefined);
  const shapeRef = useRef<[number, number]>(result?.shapeYx ?? [400, 640]);
  const drag = useRef<{ mode: "crosshair" | "window" | "pan"; x: number; y: number; width: number; center: number; panX: number; panY: number } | undefined>(undefined);

  useEffect(() => {
    setWindowing({ width: windowWidth, center: windowCenter });
  }, [windowCenter, windowWidth]);
  useEffect(() => {
    if (linkedCrosshair) setCrosshair(linkedCrosshair);
  }, [linkedCrosshair]);

  useEffect(() => {
    let cancelled = false;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const draw = async () => {
      if (isDomTestRuntime()) return;
      let context: CanvasRenderingContext2D | null = null;
      try { context = canvas.getContext("2d", { alpha: false }); } catch { return; }
      if (!context) return;
      const width = 640;
      const height = 400;
      canvas.width = width;
      canvas.height = height;
      let values: Float32Array | undefined;
      let shape = result?.shapeYx ?? [height, width];
      if (result?.artifactPath) {
        try {
          const artifact = await readBinaryArtifact(result.artifactPath);
          values = artifact.values;
          shape = [artifact.shape[0], artifact.shape[1]];
          valuesRef.current = values;
          shapeRef.current = [shape[0], shape[1]];
          if (!cancelled) setError(undefined);
        } catch (cause) {
          if (!cancelled) setError(cause instanceof Error ? cause.message : "Unable to read MPR artifact");
        }
      }
      const image = context.createImageData(width, height);
      const sourceHeight = shape[0] || height;
      const sourceWidth = shape[1] || width;
      for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
          const sx = Math.min(sourceWidth - 1, Math.floor(x * sourceWidth / width));
          const sy = Math.min(sourceHeight - 1, Math.floor(y * sourceHeight / height));
          const sourceIndex = sy * sourceWidth + sx;
          const value = values ? values[sourceIndex] : testAdapter ? -1000 + (((sx * 13 + sy * 7 + index * 17) % 1200)) : -1024;
          const gray = windowLevel(value, windowing.width, windowing.center);
          const offset = (y * width + x) * 4;
          image.data[offset] = gray;
          image.data[offset + 1] = gray;
          image.data[offset + 2] = gray;
          image.data[offset + 3] = 255;
        }
      }
      context.putImageData(image, 0, 0);
      context.save();
      context.translate(width / 2 + view.panX, height / 2 + view.panY);
      context.scale(view.zoom, view.zoom);
      context.translate(-width / 2, -height / 2);
      context.strokeStyle = orange;
      context.lineWidth = 1 / view.zoom;
      context.beginPath(); context.moveTo(crosshair.x * width, 0); context.lineTo(crosshair.x * width, height); context.moveTo(0, crosshair.y * height); context.lineTo(width, crosshair.y * height); context.stroke();
      context.restore();
      context.fillStyle = "#ecf0f1"; context.font = "600 14px system-ui"; context.fillText(plane[0].toUpperCase() + plane.slice(1), 12, 22);
      context.font = "12px system-ui"; context.fillText(`slice ${index} · ${result?.coordinateMm?.toFixed(2) ?? "—"} mm`, 12, height - 12); context.textAlign = "right"; context.fillText(`W ${Math.round(windowing.width)} / L ${Math.round(windowing.center)}`, width - 12, height - 12); context.textAlign = "left";
    };
    void draw();
    return () => { cancelled = true; };
  }, [crosshair, index, plane, result, testAdapter, view, windowing]);

  const eventPoint = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)), y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)) };
  };
  const handlePointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const point = eventPoint(event);
    event.currentTarget.setPointerCapture(event.pointerId);
    const mode = event.shiftKey ? "window" : event.button === 1 || event.altKey ? "pan" : "crosshair";
    drag.current = { mode, x: event.clientX, y: event.clientY, width: windowing.width, center: windowing.center, panX: view.panX, panY: view.panY };
    if (mode === "crosshair") { setCrosshair(point); onCrosshair?.(point.x, point.y); }
  };
  const handlePointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const active = drag.current;
    const point = eventPoint(event);
    const [height, width] = shapeRef.current;
    const sx = Math.max(0, Math.min(width - 1, Math.floor(point.x * width)));
    const sy = Math.max(0, Math.min(height - 1, Math.floor(point.y * height)));
    const value = valuesRef.current?.[sy * width + sx] ?? (testAdapter ? -1000 + (((sx * 13 + sy * 7 + index * 17) % 1200)) : -1024);
    setSampleHu(value);
    if (!active) return;
    if (active.mode === "crosshair") { setCrosshair(point); onCrosshair?.(point.x, point.y); }
    if (active.mode === "window") { const width = Math.max(1, active.width + (event.clientX - active.x) * 4); const center = active.center - (event.clientY - active.y) * 4; setWindowing({ width, center }); onWindowLevel?.(width, center); }
    if (active.mode === "pan") setView((value) => ({ ...value, panX: active.panX + event.clientX - active.x, panY: active.panY + event.clientY - active.y }));
  };
  const handlePointerUp = (event: ReactPointerEvent<HTMLCanvasElement>) => { drag.current = undefined; event.currentTarget.releasePointerCapture(event.pointerId); };
  const reset = () => { setView({ zoom: 1, panX: 0, panY: 0 }); setWindowing({ width: windowWidth, center: windowCenter }); setCrosshair({ x: 0.5, y: 0.5 }); setSampleHu(-1024); onCrosshair?.(0.5, 0.5); };
  return <button type="button" className={`ct-pane interactive-mpr ${selected ? "selected" : ""}`} onClick={onSelect} aria-label={testAdapter ? `${plane} synthetic CT slice` : `${plane} DICOM MPR pane`}>
    <canvas ref={canvasRef} role="img" aria-label={`${plane} MPR from ${result?.source ?? "sidecar"}`} onWheel={(event) => { event.preventDefault(); if (event.ctrlKey || event.metaKey) setView((value) => ({ ...value, zoom: Math.max(0.5, Math.min(8, value.zoom * (event.deltaY > 0 ? 0.9 : 1.1))) })); else onSliceChange?.(event.deltaY > 0 ? 1 : -1); }} onDoubleClick={reset} onPointerDown={handlePointerDown} onPointerMove={handlePointerMove} onPointerUp={handlePointerUp} onPointerCancel={handlePointerUp} />
    <span className="mpr-orientation-labels" aria-hidden="true">L/R · A/P · S/I</span>
    <span className="mpr-readout" aria-live="polite">HU {Math.round(sampleHu)} · voxel {Math.round(crosshair.x * (result?.shapeYx?.[1] ?? 0))},{Math.round(crosshair.y * (result?.shapeYx?.[0] ?? 0))} · physical {result?.coordinateMm?.toFixed(2) ?? "—"} mm · zoom {view.zoom.toFixed(2)}×</span>
    {error && <span className="mpr-artifact-error">{error}</span>}
  </button>;
}

export function VolumePreview({ cropActive = true }: { cropActive?: boolean }) {
  return <div className="volume-preview" role="img" aria-label="Synthetic 3D volume preview with physical crop box">
    <svg viewBox="0 0 520 330" preserveAspectRatio="none">
      <rect width="520" height="330" fill="#101314" />
      <path d="M140 56 371 34l89 52-230 33-90-63Z" fill="#899092" opacity=".34" />
      <path d="m140 56 90 63v166l-90-62V56ZM230 119l230-33v166l-230 33V119Z" fill="#4f585a" stroke="#afb4b6" strokeWidth="1.2" opacity=".85" />
      <path d="M146 71 374 50l71 40-226 32-73-51ZM153 96l220-20 59 32-219 29-60-41ZM158 123l210-18 55 29-205 26-60-37ZM166 151l198-16 51 27-194 24-55-35" fill="none" stroke="#c4c7c8" strokeWidth="1" opacity=".32" />
      <path d="M228 119v166M284 111v166M343 102v164M401 95v163" stroke="#9fa3a5" opacity=".3" />
      {cropActive && <><path d="M108 62 362 36l103 57-258 34-99-65ZM114 234l99 65 258-35-103-57-254 27Z" fill="none" stroke={orange} strokeWidth="1.5" strokeDasharray="6 5" /><g fill={orange}>{[[108,62],[362,36],[465,93],[210,127],[114,234],[213,299],[471,264],[217,242]].map(([x, y], i) => <rect key={i} x={x - 4} y={y - 4} width="8" height="8" rx="1" />)}</g><path d="M111 176h356" stroke={orange} strokeWidth="1.1" opacity=".8" /></>}
      <g transform="translate(28 254)"><path d="m0 28 28-16 28 16-28 16L0 28Z" fill="none" stroke="#e2e4e5"/><path d="M28 12v32M0 28v34M56 28v34" stroke="#e2e4e5"/><text x="28" y="8" textAnchor="middle" fill="#d7e4f0" fontSize="11">S</text><text x="-4" y="30" fill="#d7e4f0" fontSize="11">R</text><text x="58" y="30" fill="#d7e4f0" fontSize="11">A</text></g>
      <text x="490" y="26" textAnchor="end" fill="#d1d5d6" fontSize="12">Refined preview · 256³</text>
      <text x="490" y="312" textAnchor="end" fill="#9ca1a3" fontSize="12">Crop in patient coordinates</text>
    </svg>
  </div>;
}

let cachedWebgl2Availability: boolean | undefined;

function webgl2Available(): boolean {
  if (typeof document === "undefined" || isDomTestRuntime()) return false;
  if (cachedWebgl2Availability !== undefined) return cachedWebgl2Availability;
  try {
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("webgl2");
    cachedWebgl2Availability = Boolean(context);
    context?.getExtension("WEBGL_lose_context")?.loseContext();
    return cachedWebgl2Availability;
  } catch {
    cachedWebgl2Availability = false;
    return false;
  }
}

function WebGL2Unavailable({ label }: { label: string }) {
  return <div className="webgl2-unavailable" role="alert"><Icon name="warning" size={18} /><strong>WebGL2 unavailable</strong><span>{label} requires a WebGL2-capable renderer; no approximate canvas fallback is used.</span></div>;
}

const volumeVertexShader = /* glsl */ `#version 300 es
in vec3 position;
uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
out vec3 vPosition;
void main() {
  vPosition = position * 0.5 + 0.5;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const volumeFragmentShader = /* glsl */ `#version 300 es
precision highp float;
precision highp sampler3D;
uniform sampler3D volume;
uniform int mode;
uniform float threshold;
in vec3 vPosition;
out vec4 outColor;
void main() {
  vec3 ray = normalize(vec3(0.0, 0.0, 1.0));
  float maximum = 0.0;
  float accumulation = 0.0;
  float alpha = 0.0;
  for (int step = 0; step < 96; step++) {
    float t = float(step) / 95.0;
    vec3 samplePosition = clamp(vPosition - ray * (t - 0.5), 0.0, 1.0);
    float value = texture(volume, samplePosition).r;
    if (mode == 1) maximum = max(maximum, value);
    else if (mode == 2) { if (value >= threshold && alpha == 0.0) { alpha = 0.92; accumulation = value; } }
    else { float sampleAlpha = smoothstep(0.18, 0.82, value) * 0.06; accumulation += value * sampleAlpha * (1.0 - alpha); alpha += sampleAlpha * (1.0 - alpha); }
  }
  float intensity = mode == 1 ? maximum : accumulation;
  if (mode == 2 && alpha == 0.0) discard;
  float a = mode == 2 ? alpha : max(alpha, 0.45);
  outColor = vec4(vec3(intensity * 0.82 + 0.16, intensity * 0.94 + 0.12, intensity + 0.1), a);
}`;

function VolumeShaderMesh({ texture, mode, threshold }: { texture: THREE.Data3DTexture; mode: "dvr" | "mip" | "iso"; threshold: number }) {
  const material = useMemo(() => new THREE.ShaderMaterial({
    uniforms: { volume: { value: texture }, mode: { value: mode === "dvr" ? 0 : mode === "mip" ? 1 : 2 }, threshold: { value: threshold } },
    vertexShader: volumeVertexShader,
    fragmentShader: volumeFragmentShader,
    transparent: true,
    side: THREE.BackSide,
    depthWrite: false,
    glslVersion: THREE.GLSL3,
  }), [mode, texture, threshold]);
  useEffect(() => () => material.dispose(), [material]);
  return <mesh><boxGeometry args={[2, 2, 2]} /><primitive object={material} attach="material" /></mesh>;
}

function normalizeVolumeValues(values: Float32Array, windowWidth?: number, windowCenter?: number): Float32Array {
  let minimum = Infinity;
  let maximum = -Infinity;
  values.forEach((value) => {
    if (Number.isFinite(value)) {
      minimum = Math.min(minimum, value);
      maximum = Math.max(maximum, value);
    }
  });
  if (!Number.isFinite(minimum) || !Number.isFinite(maximum) || (minimum >= 0 && maximum <= 1)) return values;
  const lower = Number.isFinite(windowWidth) && Number.isFinite(windowCenter) ? Number(windowCenter) - Number(windowWidth) / 2 : minimum;
  const range = Number.isFinite(windowWidth) && Number(windowWidth) > 0 ? Number(windowWidth) : Math.max(1e-6, maximum - minimum);
  return Float32Array.from(values, (value) => Number.isFinite(value) ? Math.max(0, Math.min(1, (value - lower) / range)) : 0);
}

function VolumeCropHandles({ crop, bounds, onCropChange }: { crop?: CropBounds; bounds?: CropBounds; onCropChange?: (crop: CropBounds) => void }) {
  const [active, setActive] = useState<{ axis: keyof CropBounds; side: 0 | 1 }>();
  if (!crop || !bounds || !onCropChange) return null;
  const position = (axis: keyof CropBounds, side: 0 | 1): [number, number, number] => {
    const values = [0, 0, 0];
    (Object.keys(bounds) as Array<keyof CropBounds>).forEach((key, index) => { const range = bounds[key]; values[index] = ((crop[key][side] - range[0]) / Math.max(1e-6, range[1] - range[0])) * 2 - 1; });
    return values as [number, number, number];
  };
  return <group>{(Object.keys(bounds) as Array<keyof CropBounds>).flatMap((axis) => [0, 1].map((side) => <mesh key={`${axis}-${side}`} position={position(axis, side as 0 | 1)} onPointerDown={(event) => { event.stopPropagation(); setActive({ axis, side: side as 0 | 1 }); }} onPointerUp={() => setActive(undefined)} onPointerMove={(event) => {
    if (!active || active.axis !== axis || active.side !== side) return;
    event.stopPropagation();
    const component = axis === "x" ? event.point.x : axis === "y" ? event.point.y : event.point.z;
    const normalized = Math.max(-1, Math.min(1, component));
    const range = bounds[axis];
    const nextValue = range[0] + ((normalized + 1) / 2) * (range[1] - range[0]);
    const next = [...crop[axis]] as [number, number];
    next[side] = Math.max(range[0], Math.min(range[1], nextValue));
    if (next[0] > next[1]) next[side] = next[side === 0 ? 1 : 0];
    onCropChange({ ...crop, [axis]: next });
  }}><sphereGeometry args={[0.07, 12, 8]} /><meshBasicMaterial color={orange} /></mesh>))}</group>;
}

function VolumeScene({ result, values, shape, mode, threshold, windowWidth, windowCenter, crop, bounds, onCropChange }: { result?: VolumePreviewResult; values: Float32Array; shape: [number, number, number]; mode: "dvr" | "mip" | "iso"; threshold: number; windowWidth?: number; windowCenter?: number; crop?: CropBounds; bounds?: CropBounds; onCropChange?: (crop: CropBounds) => void }) {
  const texture = useMemo(() => {
    const [depth, height, width] = shape;
    const data = new THREE.Data3DTexture(normalizeVolumeValues(values, windowWidth, windowCenter), width, height, depth);
    data.format = THREE.RedFormat;
    data.type = THREE.FloatType;
    data.minFilter = THREE.LinearFilter;
    data.magFilter = THREE.LinearFilter;
    data.unpackAlignment = 1;
    data.needsUpdate = true;
    return data;
  }, [shape, values, windowCenter, windowWidth]);
  return <>
    <PerspectiveCamera makeDefault position={[3.4, 2.5, 3.4]} fov={42} near={0.1} far={100} />
    <ambientLight intensity={0.2} />
    <VolumeShaderMesh texture={texture} mode={mode} threshold={threshold} />
    <mesh rotation={[0, 0, 0]}><boxGeometry args={[2.02, 2.02, 2.02]} /><meshBasicMaterial color={orange} wireframe transparent opacity={0.48} /></mesh>
    <Line points={[[0, 0, -1.04], [0, 0, 1.04]]} color={orange} lineWidth={1} transparent opacity={0.7} />
    <Line points={[[-1.04, 0, 0], [1.04, 0, 0]]} color={orange} lineWidth={1} transparent opacity={0.7} />
    <Line points={[[0, -1.04, 0], [0, 1.04, 0]]} color={orange} lineWidth={1} transparent opacity={0.7} />
    <VolumeCropHandles crop={crop} bounds={bounds} onCropChange={onCropChange} />
    <OrbitControls makeDefault enablePan enableZoom enableRotate />
    <Html position={[-1, 1.1, 0]} transform><span className="volume-overlay-label">{mode.toUpperCase()} · {result?.resolution ?? `${shape.join(" × ")}`} · preview only</span></Html>
  </>;
}

export function InteractiveVolumePreview({ result, onReset, windowWidth, windowCenter, crop, bounds, onCropChange }: { result?: VolumePreviewResult; onReset?: () => void; windowWidth?: number; windowCenter?: number; crop?: CropBounds; bounds?: CropBounds; onCropChange?: (crop: CropBounds) => void }) {
  const [payload, setPayload] = useState<{ values: Float32Array; shape: [number, number, number] }>();
  const [error, setError] = useState<string>();
  const [mode, setMode] = useState<"dvr" | "mip" | "iso">("dvr");
  const [threshold, setThreshold] = useState(0.52);
  const [cameraVersion, setCameraVersion] = useState(0);
  useEffect(() => {
    let cancelled = false;
    if (!result?.artifactPath) { setPayload(undefined); return; }
    void readBinaryArtifact(result.artifactPath).then((artifact) => {
      if (!cancelled && artifact.shape.length === 3) setPayload({ values: artifact.values, shape: [artifact.shape[0], artifact.shape[1], artifact.shape[2]] });
    }).catch((cause) => { if (!cancelled) setError(cause instanceof Error ? cause.message : "Unable to read volume preview artifact"); });
    return () => { cancelled = true; };
  }, [result?.artifactPath]);
  const reset = () => { setCameraVersion((value) => value + 1); onReset?.(); };
  return <div className="volume-preview interactive-volume" role="img" aria-label="Interactive WebGL2 DICOM volume preview" data-voxelweave-renderer="three-r3f">
    {!webgl2Available() && <WebGL2Unavailable label="The DICOM volume" />}
    {webgl2Available() && !payload && <div className="volume-artifact-state"><Icon name="database" size={18} /><span>{error ?? "Waiting for the binary preview payload from the local sidecar…"}</span></div>}
    {webgl2Available() && payload && <Canvas key={cameraVersion} gl={{ antialias: true, powerPreference: "high-performance" }} onCreated={({ gl }) => { if (!gl.capabilities.isWebGL2) setError("The active renderer did not expose WebGL2"); }}><VolumeScene result={result} values={payload.values} shape={payload.shape} mode={mode} threshold={threshold} windowWidth={windowWidth} windowCenter={windowCenter} crop={crop} bounds={bounds} onCropChange={onCropChange} /></Canvas>}
    <div className="volume-controls" role="group" aria-label="Volume rendering mode"><select aria-label="Volume mode" value={mode} onChange={(event) => setMode(event.target.value as typeof mode)}><option value="dvr">DVR</option><option value="mip">MIP</option><option value="iso">Isosurface</option></select>{mode === "iso" && <input aria-label="Isosurface threshold" type="range" min="0" max="1" step="0.01" value={threshold} onChange={(event) => setThreshold(Number(event.target.value))} />}<button type="button" className="volume-reset" aria-label="Reset volume view" onClick={reset}><Icon name="fit" size={14} /></button></div>
  </div>;
}

function meshGeometry(object: SceneObject): THREE.BufferGeometry {
  if (object.vertices?.length && object.faces?.length) {
    const geometry = new THREE.BufferGeometry();
    const vertices = new Float32Array(object.vertices.flatMap((vertex) => [vertex[0] ?? 0, vertex[2] ?? 0, -(vertex[1] ?? 0)]));
    const indices = new Uint32Array(object.faces.flatMap((face) => [face[0] ?? 0, face[1] ?? 0, face[2] ?? 0]));
    geometry.setAttribute("position", new THREE.BufferAttribute(vertices, 3));
    geometry.setIndex(new THREE.BufferAttribute(indices, 1));
    geometry.computeVertexNormals();
    return geometry;
  }
  const dimensions = object.dimensionsMm ?? object.transform.scale;
  if (object.kind === "cylinder") return new THREE.CylinderGeometry(Math.max(0.1, dimensions.x / 2), Math.max(0.1, dimensions.x / 2), Math.max(0.1, dimensions.z), 48);
  if (object.kind === "polygon-prism") return new THREE.CylinderGeometry(Math.max(0.1, dimensions.x / 2), Math.max(0.1, dimensions.x / 2), Math.max(0.1, dimensions.z), Math.max(3, object.polygonSides ?? 6));
  return new THREE.BoxGeometry(Math.max(0.1, dimensions.x), Math.max(0.1, dimensions.z), Math.max(0.1, dimensions.y));
}

function roundedVector(vector: Vec3): Vec3 {
  return { x: Number(vector.x.toFixed(4)), y: Number(vector.y.toFixed(4)), z: Number(vector.z.toFixed(4)) };
}

export function scenePositionToThree(position: Vec3): [number, number, number] {
  return [position.x, position.z, -position.y];
}

export function threePositionToScene(position: THREE.Vector3): Vec3 {
  return roundedVector({ x: position.x, y: -position.z, z: position.y });
}

const sceneToThreeBasis = new THREE.Matrix4().makeRotationX(-Math.PI / 2);
const threeToSceneBasis = sceneToThreeBasis.clone().invert();

export function sceneRotationToThree(rotation: Vec3): [number, number, number] {
  const sceneMatrix = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(
    THREE.MathUtils.degToRad(rotation.x),
    THREE.MathUtils.degToRad(rotation.y),
    THREE.MathUtils.degToRad(rotation.z),
    "XYZ",
  ));
  const threeMatrix = sceneToThreeBasis.clone().multiply(sceneMatrix).multiply(threeToSceneBasis);
  const threeEuler = new THREE.Euler().setFromRotationMatrix(threeMatrix, "XYZ");
  return [threeEuler.x, threeEuler.y, threeEuler.z];
}

export function threeRotationToScene(rotation: THREE.Euler): Vec3 {
  const threeMatrix = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(rotation.x, rotation.y, rotation.z, "XYZ"));
  const sceneMatrix = threeToSceneBasis.clone().multiply(threeMatrix).multiply(sceneToThreeBasis);
  const sceneEuler = new THREE.Euler().setFromRotationMatrix(sceneMatrix, "XYZ");
  return roundedVector({
    x: THREE.MathUtils.radToDeg(sceneEuler.x),
    y: THREE.MathUtils.radToDeg(sceneEuler.y),
    z: THREE.MathUtils.radToDeg(sceneEuler.z),
  });
}

function geometryDimensions(object: SceneObject): Vec3 {
  return object.sourceDimensionsMm ?? object.dimensionsMm ?? object.transform.scale;
}

export function sceneScaleToThree(object: SceneObject): [number, number, number] {
  if (object.kind === "dicom") return [1, 1, 1];
  const base = geometryDimensions(object);
  return [object.transform.scale.x / base.x, object.transform.scale.z / base.z, object.transform.scale.y / base.y];
}

export function threeScaleToScene(object: SceneObject, scale: THREE.Vector3): Vec3 {
  const base = geometryDimensions(object);
  return roundedVector({
    x: Math.max(0.001, Math.abs(scale.x) * base.x),
    y: Math.max(0.001, Math.abs(scale.z) * base.y),
    z: Math.max(0.001, Math.abs(scale.y) * base.z),
  });
}

type DirectManipulationState = {
  pointerId: number;
  clientX: number;
  clientY: number;
  position: THREE.Vector3;
  unitsPerPixel: number;
  right: THREE.Vector3;
  up: THREE.Vector3;
  startTransform: SceneObject["transform"];
  currentTransform: SceneObject["transform"];
  moved: boolean;
};

function cloneTransform(transform: SceneObject["transform"]): SceneObject["transform"] {
  return {
    position: { ...transform.position },
    rotation: { ...transform.rotation },
    scale: { ...transform.scale },
  };
}

export function directGestureTransform(start: SceneObject["transform"], mode: SceneTransformMode, deltaX: number, deltaY: number, snapEnabled: boolean): SceneObject["transform"] {
  const next = cloneTransform(start);
  if (mode === "rotate") {
    const snap = (value: number) => snapEnabled ? Math.round(value / 15) * 15 : value;
    next.rotation.x = Number(snap(start.rotation.x - deltaY * 0.45).toFixed(4));
    next.rotation.z = Number(snap(start.rotation.z + deltaX * 0.45).toFixed(4));
  } else if (mode === "scale") {
    let factor = Math.max(0.05, 1 + (deltaX - deltaY) / 200);
    if (snapEnabled) factor = Math.max(0.05, Math.round(factor / 0.05) * 0.05);
    next.scale = roundedVector({
      x: Math.max(0.001, start.scale.x * factor),
      y: Math.max(0.001, start.scale.y * factor),
      z: Math.max(0.001, start.scale.z * factor),
    });
  }
  return next;
}

function transformsMatch(left: SceneObject["transform"], right: SceneObject["transform"]): boolean {
  return (["position", "rotation", "scale"] as const).every((part) => (["x", "y", "z"] as const).every((axis) => Math.abs(left[part][axis] - right[part][axis]) < 0.0001));
}

function SceneMesh({ object, selected, primarySelected, mode, snapEnabled, onSelect, onSelectedMesh, onTransformCommit, onDraggingChange }: { object: SceneObject; selected: boolean; primarySelected: boolean; mode: SceneTransformMode; snapEnabled: boolean; onSelect: (additive: boolean) => void; onSelectedMesh: (mesh: THREE.Mesh | null) => void; onTransformCommit: (transform: SceneObject["transform"]) => void; onDraggingChange: (dragging: boolean) => void }) {
  const meshRef = useRef<THREE.Mesh>(null);
  const directManipulationRef = useRef<DirectManipulationState | null>(null);
  const { camera, size, invalidate } = useThree();
  const registerMesh = useCallback((mesh: THREE.Mesh | null) => {
    if (mesh) mesh.userData.voxelWeaveSceneId = object.id;
    meshRef.current = mesh;
  }, [object.id]);
  useEffect(() => {
    if (!primarySelected) return;
    onSelectedMesh(meshRef.current);
    return () => onSelectedMesh(null);
  }, [onSelectedMesh, primarySelected]);
  const geometry = useMemo(
    () => meshGeometry(object),
    [object.kind, object.dimensionsMm, object.transform.scale, object.vertices, object.faces, object.polygonSides],
  );
  useEffect(() => () => geometry.dispose(), [geometry]);
  const displayedDimensions = object.kind === "dicom" ? object.dimensionsMm ?? object.transform.scale : object.transform.scale;
  const finishDirectManipulation = useCallback((pointerId: number, target?: Element) => {
    const drag = directManipulationRef.current;
    if (!drag || drag.pointerId !== pointerId) return;
    directManipulationRef.current = null;
    target?.releasePointerCapture?.(pointerId);
    onDraggingChange(false);
    if (drag.moved && !transformsMatch(drag.startTransform, drag.currentTransform)) onTransformCommit(drag.currentTransform);
  }, [onDraggingChange, onTransformCommit]);
  useEffect(() => {
    const finishPointer = (event: PointerEvent) => finishDirectManipulation(event.pointerId, event.target instanceof Element ? event.target : undefined);
    const finishBlur = () => {
      const pointerId = directManipulationRef.current?.pointerId;
      if (pointerId !== undefined) finishDirectManipulation(pointerId);
    };
    window.addEventListener("pointerup", finishPointer);
    window.addEventListener("pointercancel", finishPointer);
    window.addEventListener("blur", finishBlur);
    return () => {
      window.removeEventListener("pointerup", finishPointer);
      window.removeEventListener("pointercancel", finishPointer);
      window.removeEventListener("blur", finishBlur);
    };
  }, [finishDirectManipulation]);
  const startDirectManipulation = (pointerId: number, clientX: number, clientY: number, target?: Element) => {
    if (object.kind === "dicom" || object.locked || !meshRef.current) return;
    const mesh = meshRef.current;
    const distance = Math.max(1, camera.position.distanceTo(mesh.getWorldPosition(new THREE.Vector3())));
    const perspective = camera instanceof THREE.PerspectiveCamera ? 2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) * distance : 100 / Math.max(0.001, (camera as THREE.OrthographicCamera).zoom);
    const startTransform = cloneTransform(object.transform);
    directManipulationRef.current = {
      pointerId,
      clientX,
      clientY,
      position: mesh.position.clone(),
      unitsPerPixel: perspective / Math.max(1, size.height),
      right: new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0).normalize(),
      up: new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1).normalize(),
      startTransform,
      currentTransform: cloneTransform(startTransform),
      moved: false,
    };
    target?.setPointerCapture?.(pointerId);
    onDraggingChange(true);
  };
  const manipulateDirectly = (pointerId: number, clientX: number, clientY: number) => {
    const drag = directManipulationRef.current;
    const mesh = meshRef.current;
    if (!drag || drag.pointerId !== pointerId || !mesh) return;
    const pixelDeltaX = clientX - drag.clientX;
    const pixelDeltaY = clientY - drag.clientY;
    let nextTransform = directGestureTransform(drag.startTransform, mode, pixelDeltaX, pixelDeltaY, snapEnabled);
    if (mode === "translate") {
      const nextPosition = drag.position.clone().addScaledVector(drag.right, pixelDeltaX * drag.unitsPerPixel).addScaledVector(drag.up, -pixelDeltaY * drag.unitsPerPixel);
      if (snapEnabled) nextPosition.set(Math.round(nextPosition.x * 2) / 2, Math.round(nextPosition.y * 2) / 2, Math.round(nextPosition.z * 2) / 2);
      nextTransform = { ...nextTransform, position: threePositionToScene(nextPosition) };
      mesh.position.copy(nextPosition);
    } else if (mode === "rotate") {
      mesh.rotation.set(...sceneRotationToThree(nextTransform.rotation));
    } else {
      mesh.scale.set(...sceneScaleToThree({ ...object, transform: nextTransform }));
    }
    drag.currentTransform = nextTransform;
    drag.moved = !transformsMatch(drag.startTransform, nextTransform);
    invalidate();
  };
  const gestureLabel = `${mode === "translate" ? "Move" : mode === "rotate" ? "Rotate" : "Scale"} ${object.name}`;
  return <mesh ref={registerMesh} geometry={geometry} scale={sceneScaleToThree(object)} position={scenePositionToThree(object.transform.position)} rotation={sceneRotationToThree(object.transform.rotation)} raycast={object.kind === "dicom" ? () => null : undefined} onPointerDown={(event: ThreeEvent<PointerEvent>) => { if (event.button !== 0) return; event.stopPropagation(); const additive = event.shiftKey || event.metaKey || event.ctrlKey; onSelect(additive); if (!additive) startDirectManipulation(event.pointerId, event.clientX, event.clientY, event.target as Element); }} onPointerMove={(event: ThreeEvent<PointerEvent>) => { if (directManipulationRef.current) event.stopPropagation(); manipulateDirectly(event.pointerId, event.clientX, event.clientY); }} onPointerUp={(event: ThreeEvent<PointerEvent>) => { if (directManipulationRef.current) event.stopPropagation(); finishDirectManipulation(event.pointerId, event.target as Element); }} onPointerCancel={(event: ThreeEvent<PointerEvent>) => finishDirectManipulation(event.pointerId, event.target as Element)} onLostPointerCapture={(event: ThreeEvent<PointerEvent>) => finishDirectManipulation(event.pointerId, event.target as Element)}>
      <meshStandardMaterial color={object.tool === "T1" ? "#3f8285" : object.kind === "dicom" ? "#28686d" : "#707a7c"} transparent depthWrite={object.kind !== "dicom"} opacity={object.kind === "dicom" ? 0.13 : object.visible ? 0.86 : 0.12} wireframe={object.kind === "dicom"} emissive={selected ? (primarySelected ? orange : "#2f8f91") : "#000000"} emissiveIntensity={selected ? 0.34 : 0} roughness={0.72} metalness={0.08} />
      {selected && <lineSegments><edgesGeometry args={[geometry]} /><lineBasicMaterial color={primarySelected ? orange : "#5fb6b7"} /></lineSegments>}
      {primarySelected && <Html position={[0, displayedDimensions.z / 2 + 4, 0]} center>{object.kind !== "dicom" ? <button type="button" className="scene-object-label scene-object-drag-handle" aria-label={gestureLabel} onPointerDown={(event: ReactPointerEvent<HTMLButtonElement>) => { if (event.button !== 0) return; event.stopPropagation(); const additive = event.shiftKey || event.metaKey || event.ctrlKey; if (additive) { onSelect(true); return; } startDirectManipulation(event.pointerId, event.clientX, event.clientY, event.currentTarget); }} onPointerMove={(event) => { event.stopPropagation(); manipulateDirectly(event.pointerId, event.clientX, event.clientY); }} onPointerUp={(event) => { event.stopPropagation(); finishDirectManipulation(event.pointerId, event.currentTarget); }} onPointerCancel={(event) => finishDirectManipulation(event.pointerId, event.currentTarget)} onLostPointerCapture={(event) => finishDirectManipulation(event.pointerId, event.currentTarget)}>{object.name}{object.locked ? " · locked" : ""}</button> : <span className="scene-object-label">{object.name}</span>}</Html>}
    </mesh>;
}

function CameraFitController({ fitVersion, target, waitForTarget }: { fitVersion: number; target: THREE.Object3D | null; waitForTarget: boolean }) {
  const bounds = useBounds();
  const completedVersion = useRef(-1);
  useEffect(() => {
    if (completedVersion.current === fitVersion || (waitForTarget && !target)) return;
    completedVersion.current = fitVersion;
    const frame = window.requestAnimationFrame(() => bounds.refresh(target ?? undefined).fit().clip());
    return () => window.cancelAnimationFrame(frame);
  }, [bounds, fitVersion, target, waitForTarget]);
  return null;
}

function DesignScene({ selectedId, selectedIds, mode, snapEnabled, gridVisible, fitVersion, fitTargetId, onSelect, onTransformCommit, onDraggingChange, scene }: { selectedId: string; selectedIds: string[]; mode: SceneTransformMode; snapEnabled: boolean; gridVisible: boolean; fitVersion: number; fitTargetId?: string; onSelect: (id: string, additive: boolean) => void; onTransformCommit: (id: string, transform: SceneObject["transform"]) => void; onDraggingChange: (dragging: boolean) => void; scene: SceneObject[] }) {
  const [orbitEnabled, setOrbitEnabled] = useState(true);
  const [selectedMesh, setSelectedMesh] = useState<THREE.Mesh | null>(null);
  const transformControlsRef = useRef<ElementRef<typeof TransformControls>>(null);
  const transformStartRef = useRef<SceneObject["transform"] | null>(null);
  const transformDraggingRef = useRef(false);
  const selectedObject = scene.find((object) => object.id === selectedId);
  const selectedMeshMatches = Boolean(selectedMesh?.parent && selectedMesh.userData.voxelWeaveSceneId === selectedId);
  const handleDraggingChange = useCallback((dragging: boolean) => { setOrbitEnabled(!dragging); onDraggingChange(dragging); }, [onDraggingChange]);
  const commitTransform = useCallback(() => {
    if (!transformDraggingRef.current && !transformStartRef.current) return;
    transformDraggingRef.current = false;
    handleDraggingChange(false);
    if (!selectedMesh || !selectedMeshMatches || !selectedObject || selectedObject.kind === "dicom" || selectedObject.locked) return;
    const mappedRotation = threeRotationToScene(selectedMesh.rotation);
    const next = {
      position: threePositionToScene(selectedMesh.position),
      rotation: mode === "rotate" && snapEnabled ? roundedVector({
        x: Math.round(mappedRotation.x / 15) * 15,
        y: Math.round(mappedRotation.y / 15) * 15,
        z: Math.round(mappedRotation.z / 15) * 15,
      }) : mappedRotation,
      scale: threeScaleToScene(selectedObject, selectedMesh.scale),
    };
    const start = transformStartRef.current ?? selectedObject.transform;
    transformStartRef.current = null;
    if (!transformsMatch(start, next)) onTransformCommit(selectedObject.id, next);
  }, [handleDraggingChange, mode, onTransformCommit, selectedMesh, selectedMeshMatches, selectedObject, snapEnabled]);
  useEffect(() => {
    const finishInterruptedTransform = () => {
      if (!transformDraggingRef.current) return;
      const controls = transformControlsRef.current as unknown as { pointerUp?: (pointer: { button: number }) => void } | null;
      controls?.pointerUp?.({ button: 0 });
      if (transformDraggingRef.current) commitTransform();
    };
    window.addEventListener("pointerup", finishInterruptedTransform);
    window.addEventListener("pointercancel", finishInterruptedTransform);
    window.addEventListener("blur", finishInterruptedTransform);
    return () => {
      window.removeEventListener("pointerup", finishInterruptedTransform);
      window.removeEventListener("pointercancel", finishInterruptedTransform);
      window.removeEventListener("blur", finishInterruptedTransform);
    };
  }, [commitTransform]);
  return <>
    <PerspectiveCamera makeDefault position={[120, 120, 160]} fov={42} near={0.1} far={2000} />
    <ambientLight intensity={0.58} />
    <directionalLight position={[140, 180, 120]} intensity={1.3} />
    {gridVisible && <gridHelper args={[400, 40, "#697477", "#273033"]} rotation={[0, 0, 0]} />}
    <axesHelper args={[60]} />
    <Bounds fit clip margin={1.25}><group>{scene.filter((object) => object.visible).map((object) => <SceneMesh key={object.id} object={object} selected={selectedIds.includes(object.id)} primarySelected={object.id === selectedId} mode={mode} snapEnabled={snapEnabled} onSelect={(additive) => onSelect(object.id, additive)} onSelectedMesh={setSelectedMesh} onTransformCommit={(transform) => onTransformCommit(object.id, transform)} onDraggingChange={handleDraggingChange} />)}</group><CameraFitController fitVersion={fitVersion} target={fitTargetId === selectedId ? selectedMesh : null} waitForTarget={Boolean(fitTargetId)} /></Bounds>
    {selectedMesh && selectedMeshMatches && selectedObject && selectedObject.kind !== "dicom" && !selectedObject.locked && <TransformControls
      ref={transformControlsRef}
      object={selectedMesh}
      mode={mode}
      size={1.05}
      translationSnap={snapEnabled ? 0.5 : undefined}
      rotationSnap={snapEnabled ? THREE.MathUtils.degToRad(15) : undefined}
      scaleSnap={snapEnabled ? 0.05 : undefined}
      onMouseDown={() => { transformStartRef.current = structuredClone(selectedObject.transform); transformDraggingRef.current = true; handleDraggingChange(true); }}
      onMouseUp={commitTransform}
    />}
    <OrbitControls makeDefault enabled={orbitEnabled} enablePan enableZoom enableRotate />
  </>;
}

export function DesignViewport({ selectedId, selectedIds, mode, snapEnabled, gridVisible, fitVersion, fitTargetId, onSelect, onClearSelection, onTransformCommit, onKeyboardCommand, scene = [] }: { selectedId: string; selectedIds: string[]; mode: SceneTransformMode; snapEnabled: boolean; gridVisible: boolean; fitVersion: number; fitTargetId?: string; onSelect: (id: string, additive: boolean) => void; onClearSelection: () => void; onTransformCommit: (id: string, transform: SceneObject["transform"]) => void; onKeyboardCommand: (event: ReactKeyboardEvent<HTMLDivElement>) => void; scene?: SceneObject[] }) {
  const [workerState, setWorkerState] = useState("checking preview");
  const [dragging, setDragging] = useState(false);
  const workerRef = useRef<Worker | undefined>(undefined);
  const requestIdRef = useRef(0);
  useEffect(() => {
    try {
      const worker = new Worker(new URL("../workers/manifoldWorker.ts", import.meta.url), { type: "module" });
      workerRef.current = worker;
      worker.onmessage = (event: MessageEvent<{ ok: boolean; message?: string; requestId?: number }>) => {
        if (event.data.requestId !== requestIdRef.current) return;
        setWorkerState(event.data.ok ? "preview mesh checked" : event.data.message ?? "preview check unavailable");
      };
      worker.onerror = () => setWorkerState("preview check unavailable");
    } catch { setWorkerState("preview check unavailable"); }
    return () => { workerRef.current?.terminate(); workerRef.current = undefined; };
  }, []);
  useEffect(() => {
    setWorkerState("checking preview");
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    const timer = window.setTimeout(() => {
      workerRef.current?.postMessage({ operation: "preview", requestId, scene: scene.map((object) => ({ id: object.id, kind: object.kind, dimensions: geometryDimensions(object), transform: object.transform, vertices: object.vertices, faces: object.faces, boolean: object.boolean })) });
    }, 100);
    return () => window.clearTimeout(timer);
  }, [scene]);
  const selected = scene.find((object) => object.id === selectedId);
  const modeLabel = mode === "translate" ? "Move" : mode === "rotate" ? "Rotate" : "Scale";
  return <div className={`design-viewport transform-mode-${mode} ${dragging ? "is-transforming" : ""}`} role="region" aria-label="Interactive parametric design scene" aria-describedby="design-viewport-instructions" tabIndex={0} onKeyDown={onKeyboardCommand} onPointerDown={(event) => event.currentTarget.focus({ preventScroll: true })} data-testid="design-scene-viewport" data-transform-mode={mode} data-grid-visible={gridVisible} data-snap-enabled={snapEnabled} data-voxelweave-renderer="three-r3f">
    {!webgl2Available() && <WebGL2Unavailable label="The parametric design scene" />}
    {webgl2Available() && <Canvas frameloop="demand" gl={{ antialias: true, powerPreference: "high-performance" }} onPointerMissed={onClearSelection} onCreated={({ gl }) => { if (!gl.capabilities.isWebGL2) setWorkerState("WebGL2 unavailable"); }}><DesignScene selectedId={selectedId} selectedIds={selectedIds} mode={mode} snapEnabled={snapEnabled} gridVisible={gridVisible} fitVersion={fitVersion} fitTargetId={fitTargetId} onSelect={onSelect} onTransformCommit={onTransformCommit} onDraggingChange={setDragging} scene={scene} /></Canvas>}
    <span className="viewport-badge viewport-badge-overlay">{selectedIds.length > 1 ? `${selectedIds.length} selected · ` : ""}{modeLabel} · {snapEnabled ? (mode === "translate" ? "0.5 mm snap" : mode === "rotate" ? "15° snap" : "5% snap") : "free"}{selected?.kind === "dicom" || selected?.locked ? " · geometry locked" : ""}</span>
    <span className="viewport-validation-state" aria-live="polite">{workerState}</span>
    <span className="viewport-help" id="design-viewport-instructions">Shift-click adds objects · Delete removes · ⌘D duplicates · arrows nudge · background drag orbits</span>
  </div>;
}

type PathInstance = { start: [number, number, number]; end: [number, number, number] };

function ToolpathToolInstances({ tool, active, generated }: { tool: ToolId; active: boolean; generated: boolean }) {
  const ref = useRef<THREE.InstancedMesh>(null);
  const instances = useMemo<PathInstance[]>(() => Array.from({ length: generated ? 720 : 0 }, (_, index) => {
    if ((index % 5 === 0 ? "T1" : "T0") !== tool) return undefined;
    const row = Math.floor(index / 24);
    const column = index % 24;
    const x = -80 + column * 6.8;
    const y = -55 + row * 5.8;
    const nextX = x + (row % 2 ? -5.7 : 5.7);
    return { start: [x, y, 0] as [number, number, number], end: [nextX, y + Math.sin(column * 0.8 + row) * 1.2, 0] as [number, number, number] };
  }).filter((instance): instance is PathInstance => Boolean(instance)), [generated, tool]);
  useEffect(() => {
    const mesh = ref.current;
    if (!mesh) return;
    const helper = new THREE.Object3D();
    instances.forEach((segment, index) => {
      const [sx, sy, sz] = segment.start;
      const [ex, ey, ez] = segment.end;
      const start = new THREE.Vector3(sx, sz, -sy);
      const end = new THREE.Vector3(ex, ez, -ey);
      const direction = end.clone().sub(start);
      const length = Math.max(0.1, direction.length());
      helper.position.copy(start).add(end).multiplyScalar(0.5);
      helper.quaternion.setFromUnitVectors(new THREE.Vector3(1, 0, 0), direction.normalize());
      helper.scale.set(length, 0.36, 0.36);
      helper.updateMatrix();
      mesh.setMatrixAt(index, helper.matrix);
    });
    mesh.instanceMatrix.needsUpdate = true;
  }, [instances]);
  return <instancedMesh ref={ref} args={[undefined, undefined, Math.max(1, instances.length)]} visible={instances.length > 0}><boxGeometry args={[1, 1, 1]} /><meshStandardMaterial color={active ? orange : tool === "T1" ? teal : "#aeb6b8"} roughness={0.72} metalness={0.05} /></instancedMesh>;
}

function ToolpathInstances({ selectedLayer, activeTool, generated }: { selectedLayer: number; activeTool: ToolId; generated: boolean }) {
  return <group position={[0, (selectedLayer % 20) * 0.2, 0]}>
    <ToolpathToolInstances tool="T0" active={activeTool === "T0"} generated={generated} />
    <ToolpathToolInstances tool="T1" active={activeTool === "T1"} generated={generated} />
  </group>;
}

export function ToolpathCanvas({ selectedLayer, activeTool = "T0", generated = true, totalLayers }: { selectedLayer: number; activeTool?: ToolId; generated?: boolean; totalLayers?: number }) {
  return <div className="toolpath-canvas" role="img" aria-label={`Generated segment preview for layer ${selectedLayer}`} data-voxelweave-renderer="three-r3f">
    {!webgl2Available() && <WebGL2Unavailable label="The toolpath renderer" />}
    {webgl2Available() && <Canvas frameloop="demand" gl={{ antialias: true, powerPreference: "high-performance" }}><PerspectiveCamera makeDefault position={[0, 150, 210]} fov={46} near={0.1} far={1000} /><ambientLight intensity={0.45} /><directionalLight position={[100, 120, 180]} intensity={1.1} /><gridHelper args={[220, 22, "#697477", "#293033"]} /><mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.2, 0]}><planeGeometry args={[190, 150]} /><meshStandardMaterial color="#15191a" /></mesh><ToolpathInstances selectedLayer={selectedLayer} activeTool={activeTool} generated={generated} /><OrbitControls makeDefault enablePan enableZoom enableRotate /></Canvas>}
    <span className="viewport-badge viewport-badge-overlay">Layer {selectedLayer}{totalLayers ? ` / ${totalLayers}` : ""} · {activeTool} selected · instanced paths</span>
  </div>;
}

export function CalibrationPlot({ tool = "T0", samples }: { tool?: ToolId; samples?: Array<{ widthMm: number; measuredHu: number }> }) {
  const points = samples?.length ? samples.map((sample) => [64 + Math.max(0, Math.min(1, (sample.widthMm - 0.4) / 0.8)) * 234, 186 - Math.max(0, Math.min(1, (sample.measuredHu + 900) / 900)) * 168] as [number, number]) : tool === "T0" ? [[64, 178], [142, 158], [223, 128], [298, 101]] : [[64, 191], [142, 163], [223, 131], [298, 104]];
  return <div className="calibration-plot" role="img" aria-label={`${tool} calibration width to HU plot`}>
    <svg viewBox="0 0 350 220" preserveAspectRatio="none"><path d="M44 18v168h280M44 55h280M44 97h280M44 139h280" fill="none" stroke="#dce0e0" strokeWidth="1"/><path d="M44 18v168h280" fill="none" stroke="#9ba2a4" strokeWidth="1.2"/><polyline points={points.map(([x, y]) => `${x},${y}`).join(" ")} fill="none" stroke={teal} strokeWidth="2.5" />{points.map(([x, y], i) => <circle key={i} cx={x} cy={y} r="5" fill="#fff" stroke={teal} strokeWidth="2" />)}<text x="48" y="16" fill="#596266" fontSize="11">HU</text><text x="278" y="207" fill="#596266" fontSize="11">commanded width · mm</text><text x="12" y="190" fill="#596266" fontSize="10">−900</text><text x="16" y="99" fill="#596266" fontSize="10">−450</text><text x="23" y="22" fill="#596266" fontSize="10">0</text><text x="49" y="206" fill="#596266" fontSize="10">0.4</text><text x="153" y="206" fill="#596266" fontSize="10">0.7</text><text x="258" y="206" fill="#596266" fontSize="10">1.0</text></svg>
  </div>;
}

export function ComparisonViewport({ mode }: { mode: "overlay" | "difference" | "profile" }) {
  return <div className={`comparison-viewport mode-${mode}`} role="img" aria-label={`Registered scan-back ${mode} comparison`}>
    <svg viewBox="0 0 560 300" preserveAspectRatio="none"><rect width="560" height="300" fill="#121617"/><path d="M80 186C70 127 119 72 185 78c38 4 64 29 76 63 12-36 39-60 77-63 65-5 113 49 103 108-9 51-57 76-104 64-38-10-63-31-76-67-13 36-38 57-76 67-47 12-95-13-105-64Z" fill={mode === "difference" ? "#544b2c" : "#4a5356"} stroke="#bec4c5" strokeWidth="2"/><path d="M146 104c29-26 62-19 77 17 13 30 10 68-19 86-31 19-64 7-78-28-12-29-8-56 20-75ZM414 104c-29-26-62-19-77 17-13 30-10 68 19 86 31 19 64 7 78-28 12-29 8-56-20-75Z" fill="#171a1b" stroke="#a4abad" strokeWidth="1.5"/>{mode === "overlay" && <path d="M278 76c-23 58-24 121 1 178" stroke={orange} strokeWidth="3" opacity=".9"/>}{mode === "difference" && <path d="M92 173c110-42 270-42 376 0" stroke="#d19c21" strokeWidth="9" opacity=".35" fill="none"/>}{mode === "profile" && <path d="M54 221c52-25 82-12 119-36s67-3 102-30 62-4 97-27 64-14 108-36" stroke={teal} strokeWidth="3" fill="none"/>}<text x="14" y="24" fill="#e2e5e6" fontSize="13">Scan-back · {mode}</text><text x="14" y="282" fill="#a8afb1" fontSize="11">registered evidence · no diagnostic interpretation</text></svg>
  </div>;
}

export function OrientationCube({ plane }: { plane: Orientation }) {
  return <div className="orientation-cube" aria-label={`${plane} orientation cube`}><Icon name="cube" size={28} /><span>{plane[0].toUpperCase()}</span></div>;
}
