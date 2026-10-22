// The 3D office. createOffice builds the scene inside a container and keeps it in step with the
// store: it subscribes once, diffs departments and agents by id, and changes only what changed.
// It renders on demand: a frame when the state changes, the camera moves or an avatar animates,
// and no frame at all while nothing moves.

import * as THREE from 'three';
import { CSS2DRenderer } from 'three/addons/renderers/CSS2DRenderer.js';
import { CSS3DRenderer } from 'three/addons/renderers/CSS3DRenderer.js';
import type { CreateOffice, OfficeScene, OfficeState, SceneStats, Selection } from '../../shared/scene-api';
import { Avatar, AvatarParts } from './avatar';
import { InstancedBatch } from './batch';
import { Room, Shell, type Kit } from './building';
import { GeoBuilder, chairGeometry, deskGeometry, monitorGeometry, ringGeometry, screenGeometry } from './geometry';
import { createPlantBatches } from './plants';
import { FLOOR_Y, WALL_TALL, layoutBuilding, roomClassFor, type Bounds, type BuildingLayout } from './layout';
import { COLORS } from './palette';
import { Reception } from './reception';
import { IsoRig, NO_INSET, type Inset } from './rig';
import './office-scene.css';

const MAX_PIXEL_RATIO = 1.5;
const AMBIENT_FRAME_MS = 1000 / 30; // typing and swaying need no more than 30 frames a second
const AMBIENT_SHADOW_MS = 250; // and their shadows even less
const CLICK_SLOP_PX = 5;
/** Below this view half height every bubble shows its full card. */
const CLOSE_HALF = 5.2;
const SUN_OFFSET = new THREE.Vector3(-9, 20, 11);

export const createOffice: CreateOffice = (container, store) => {
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO));
  renderer.setClearColor(COLORS.ground, 1);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.shadowMap.autoUpdate = false;
  container.appendChild(renderer.domElement);

  const labelLayer = new CSS3DRenderer();
  labelLayer.domElement.className = 'office-layer';
  container.appendChild(labelLayer.domElement);
  const bubbleLayer = new CSS2DRenderer();
  bubbleLayer.domElement.className = 'office-layer';
  container.appendChild(bubbleLayer.domElement);
  container.style.touchAction = 'none';
  // The part of the view the chrome leaves free, set by CSS (see office-scene.css); framing
  // centers in it, and the camera reframes when it changes (a panel opens or closes).
  const safeProbe = document.createElement('div');
  safeProbe.className = 'office-safe';
  safeProbe.setAttribute('aria-hidden', 'true');
  container.appendChild(safeProbe);

  const scene = new THREE.Scene();
  const hemi = new THREE.HemisphereLight('#ffffff', '#8d8577', 2.1);
  const sun = new THREE.DirectionalLight('#fffaf3', 1.7);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.025;
  scene.add(hemi, sun, sun.target);

  const ground = new THREE.Mesh(new THREE.PlaneGeometry(800, 800), new THREE.MeshBasicMaterial({ color: COLORS.ground }));
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.003;
  scene.add(ground);
  const grid = new THREE.GridHelper(250, 100, COLORS.grid, COLORS.grid);
  const gridMaterial = grid.material as THREE.LineBasicMaterial;
  gridMaterial.transparent = true;
  gridMaterial.opacity = 0.6;
  gridMaterial.depthWrite = false;
  scene.add(grid);

  const shellMaterial = new THREE.MeshLambertMaterial({ vertexColors: true });
  const propMaterial = new THREE.MeshLambertMaterial({ vertexColors: true });
  const screenMaterial = new THREE.MeshBasicMaterial();
  const kit: Kit = {
    root: scene,
    shellMaterial,
    desks: new InstancedBatch(scene, deskGeometry(), propMaterial, 64, { castShadow: true, receiveShadow: true }),
    chairs: new InstancedBatch(scene, chairGeometry(), propMaterial, 64, { castShadow: true }),
    monitors: new InstancedBatch(scene, monitorGeometry(), propMaterial, 64, { castShadow: true }),
    screens: new InstancedBatch(scene, screenGeometry(), screenMaterial, 64),
    plants: createPlantBatches(scene),
  };
  const batches = [kit.desks, kit.chairs, kit.monitors, kit.screens, ...kit.plants.list];
  const parts = new AvatarParts(scene, 32);
  const shell = new Shell(kit);

  // Highlights: a frame on the carpet of the hovered and the selected room, a ring under the
  // hovered and the selected avatar.
  const overlay = (opacity: number) =>
    new THREE.MeshBasicMaterial({ color: COLORS.highlight, transparent: true, opacity, depthWrite: false });
  const hoverFrame = new THREE.Mesh(new THREE.BufferGeometry(), overlay(0.45));
  const selectFrame = new THREE.Mesh(new THREE.BufferGeometry(), overlay(0.95));
  const ringShape = ringGeometry(0.51, 0.57);
  const hoverRing = new THREE.Mesh(ringShape, overlay(0.5));
  const selectRing = new THREE.Mesh(ringShape, overlay(0.95));
  for (const mesh of [hoverFrame, selectFrame, hoverRing, selectRing]) {
    mesh.visible = false;
    mesh.renderOrder = 2;
    scene.add(mesh);
  }

  const rig = new IsoRig();
  const rooms = new Map<string, Room>();
  /** The workplace of each department of kind `lobby` (the general manager). It has no room, no slot. */
  const receptions = new Map<string, Reception>();
  const avatars = new Map<string, Avatar>();
  /** The most subagents seen at once per department: rooms only grow. */
  const peaks = new Map<string, number>();
  const listeners = new Set<(selection: Selection) => void>();
  const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
  let reduced = motionQuery.matches;
  let layout: BuildingLayout = layoutBuilding([]);
  let framed = false;
  /** What the camera was last asked to frame, and whether it still does (no pan or zoom since). */
  let focusSel: Selection = null;
  let following = true;
  let selected: Selection = null;
  let hovered: Selection = null;
  let close = false;
  let company = '';
  let disposed = false;

  // Rendering on demand.
  let raf = 0;
  let lastFrame = 0;
  let lastRender = 0;
  let lastShadow = 0;
  let needsRender = true;
  let shadowsDirty = true;
  const frames: { at: number; calls: number; triangles: number }[] = [];

  /** A department's room, or the reception of the lobby's general manager. */
  function placeOf(id: string): (Room | Reception) | undefined {
    return rooms.get(id) ?? receptions.get(id);
  }

  function requestRender(): void {
    needsRender = true;
    schedule();
  }

  function schedule(): void {
    if (raf || disposed) return;
    const now = performance.now();
    if (now - lastFrame > 100) lastFrame = now; // waking up from idle: no long first step
    raf = requestAnimationFrame(frame);
  }

  function frame(now: number): void {
    raf = 0;
    // Motion is time based, so a throttled browser (few frames a second) still walks at full speed.
    const dt = Math.min(0.25, Math.max(0, (now - lastFrame) / 1000));
    lastFrame = now;
    if (reduced) rig.snap();
    let active = rig.update(dt);
    let ambient = false;
    let wrote = false;

    for (const room of rooms.values()) {
      if (!room.updateRise(now)) continue;
      active = true;
      shadowsDirty = true;
      for (const avatar of avatars.values()) if (avatar.room === room) avatar.invalidate();
    }
    for (const avatar of avatars.values()) {
      const tick = avatar.update(dt, now, reduced);
      active ||= tick.moving;
      ambient ||= tick.ambient;
      wrote ||= tick.wrote;
      if (avatar.mode === 'gone') {
        avatar.dispose();
        avatars.delete(avatar.id);
        needsRender = true;
      }
    }
    const nowClose = rig.halfHeight < CLOSE_HALF;
    if (nowClose !== close) {
      close = nowClose;
      applyBubbleModes();
    }
    placeRings();
    for (const batch of batches) wrote = batch.commit() || wrote;
    wrote = parts.commit() || wrote;
    if (wrote && (active || needsRender || now - lastShadow >= AMBIENT_SHADOW_MS)) shadowsDirty = true;

    if (needsRender || active || (ambient && now - lastRender >= AMBIENT_FRAME_MS)) render(now);
    if (active || ambient) schedule();
  }

  function render(now: number): void {
    needsRender = false;
    if (shadowsDirty) {
      renderer.shadowMap.needsUpdate = true;
      shadowsDirty = false;
      lastShadow = now;
    }
    // renderer.info counts the main pass: three.js resets it after the shadow pass.
    renderer.render(scene, rig.camera);
    labelLayer.render(scene, rig.camera);
    bubbleLayer.render(scene, rig.camera);
    lastRender = now;
    frames.push({ at: now, calls: renderer.info.render.calls, triangles: renderer.info.render.triangles });
    while (frames.length > 0 && frames[0].at < now - 1000) frames.shift();
  }

  // Keeping in step with the store.

  function sync(state: OfficeState, previous: OfficeState | null): void {
    const now = performance.now();
    if (state.config.company !== company) {
      company = state.config.company;
      shell.setCompany(company);
    }

    const counts = new Map<string, number>();
    for (const agent of state.agents) {
      if (agent.kind === 'subagent') counts.set(agent.department, (counts.get(agent.department) ?? 0) + 1);
    }
    for (const [id, n] of counts) peaks.set(id, Math.max(peaks.get(id) ?? 0, n));

    const departmentsChanged = !previous || previous.config.departments !== state.config.departments;
    const agentsChanged = !previous || previous.agents !== state.agents;
    let relayout = !previous;
    let reseat = false;
    if (departmentsChanged || agentsChanged) {
      const initial = rooms.size === 0;
      const seen = new Set<string>();
      const risen = new Set<Room>();
      for (const dept of state.config.departments) {
        seen.add(dept.id);
        if (dept.kind === 'lobby') {
          const reception = receptions.get(dept.id);
          if (!reception) {
            receptions.set(dept.id, new Reception(kit, dept));
            reseat = true;
          } else if (reception.dept !== dept) {
            const recolor = reception.dept.color !== dept.color;
            reception.update(dept);
            if (recolor) for (const avatar of avatars.values()) if (avatar.room === reception) avatar.paint();
          }
          continue;
        }
        const cls = roomClassFor(dept.slot, peaks.get(dept.id) ?? 0);
        const room = rooms.get(dept.id);
        if (!room) {
          const created = new Room(kit, dept, cls);
          rooms.set(dept.id, created);
          if (!initial && !reduced) risen.add(created);
          relayout = true;
        } else if (room.dept !== dept || room.cls !== cls) {
          const recolor = room.dept.color !== dept.color;
          if (room.update(dept, cls)) relayout = true;
          if (recolor) for (const avatar of avatars.values()) if (avatar.room === room) avatar.paint();
        }
      }
      for (const [id, room] of rooms) {
        if (seen.has(id)) continue;
        for (const avatar of [...avatars.values()]) {
          if (avatar.room !== room) continue;
          avatar.dispose();
          avatars.delete(avatar.id);
        }
        room.dispose();
        rooms.delete(id);
        peaks.delete(id);
        relayout = true;
      }
      for (const [id, reception] of receptions) {
        if (seen.has(id)) continue;
        for (const avatar of [...avatars.values()]) {
          if (avatar.room !== reception) continue;
          avatar.dispose();
          avatars.delete(avatar.id);
        }
        reception.dispose();
        receptions.delete(id);
      }
      if (relayout) applyLayout(risen, now);
    }

    if (agentsChanged || relayout || reseat) {
      const present = new Set<string>();
      for (const agent of state.agents) {
        const room = placeOf(agent.department);
        if (!room) continue;
        present.add(agent.id);
        const avatar = avatars.get(agent.id);
        if (avatar && avatar.pickable) {
          if (avatar.agent !== agent) avatar.setAgent(agent, now);
          continue;
        }
        if (avatar) {
          avatar.dispose();
          avatars.delete(agent.id);
        }
        const seat = room.claim(agent.id, agent.kind);
        const arrive = agent.status === 'arriving' && !reduced && room.walksOut;
        avatars.set(agent.id, new Avatar(parts, scene, agent, room, seat, arrive, now));
      }
      for (const avatar of avatars.values()) {
        if (present.has(avatar.id) || !avatar.pickable) continue;
        avatar.room.release(avatar.seat, avatar.id);
        avatar.leave(now);
      }
    }

    if (!previous || previous.sessions !== state.sessions || agentsChanged || relayout) {
      for (const room of rooms.values()) {
        room.setSummary(
          state.sessions.find((s) => s.department === room.id),
          counts.get(room.id) ?? 0,
        );
      }
    }

    if (!previous || previous.selected !== state.selected || agentsChanged || relayout || reseat) {
      selected = state.selected;
      applyHighlights();
    }
    requestRender();
  }

  function applyLayout(risen: Set<Room>, now: number): void {
    layout = layoutBuilding([...rooms.values()].map((room) => ({ id: room.id, slot: room.dept.slot, cls: room.cls })));
    for (const room of rooms.values()) {
      const place = layout.rooms.get(room.id);
      if (place) room.setPlace(place, risen.has(room), now);
    }
    shell.build(layout);
    for (const avatar of avatars.values()) {
      if (!avatar.pickable || avatar.seat.kind === 'head') {
        avatar.invalidate();
        continue;
      }
      avatar.reseat(avatar.room.seatOf(avatar.id) ?? avatar.room.claim(avatar.id, 'subagent'));
    }
    fitShadow(layout.bounds);
    rig.setLimits(layout.bounds, 6);
    rig.maxHalf = Math.max(14, frameBuilding(NO_INSET).half * 1.7);
    const hasRooms = rooms.size > 0;
    if (following) refocus(framed && hasRooms && !reduced);
    if (hasRooms) framed = true;
    shadowsDirty = true;
    applyHighlights();
  }

  function fitShadow(bounds: Bounds): void {
    const cx = (bounds.minX + bounds.maxX) / 2;
    const cz = (bounds.minZ + bounds.maxZ) / 2;
    sun.target.position.set(cx, 0, cz);
    sun.position.set(cx + SUN_OFFSET.x, SUN_OFFSET.y, cz + SUN_OFFSET.z);
    sun.target.updateMatrixWorld();
    sun.updateMatrixWorld();
    const cam = sun.shadow.camera;
    cam.position.copy(sun.position);
    cam.lookAt(sun.target.position);
    cam.updateMatrixWorld();
    const box = new THREE.Box3();
    const v = new THREE.Vector3();
    for (const x of [bounds.minX, bounds.maxX]) {
      for (const y of [0, WALL_TALL + 0.2]) {
        for (const z of [bounds.minZ, bounds.maxZ]) box.expandByPoint(v.set(x, y, z).applyMatrix4(cam.matrixWorldInverse));
      }
    }
    cam.left = box.min.x - 0.5;
    cam.right = box.max.x + 0.5;
    cam.bottom = box.min.y - 0.5;
    cam.top = box.max.y + 0.5;
    cam.near = Math.max(0.1, -box.max.z - 2);
    cam.far = -box.min.z + 2;
    cam.updateProjectionMatrix();
  }

  // Camera framing.

  function safeInset(): Inset {
    const c = container.getBoundingClientRect();
    const p = safeProbe.getBoundingClientRect();
    if (p.width < 1 || p.height < 1) return NO_INSET;
    return { left: p.left - c.left, top: p.top - c.top, right: c.right - p.right, bottom: c.bottom - p.bottom };
  }

  function frameBuilding(inset: Inset): { target: THREE.Vector3; half: number } {
    const b = layout.bounds;
    const points: THREE.Vector3[] = [];
    for (const x of [b.minX, b.maxX]) {
      for (const z of [b.minZ, b.maxZ]) points.push(new THREE.Vector3(x, 0, z), new THREE.Vector3(x, WALL_TALL + 1, z));
    }
    return rig.frame(points, 1.08, inset);
  }

  function frameFor(selection: Selection): { target: THREE.Vector3; half: number } | null {
    const inset = safeInset();
    if (!selection) return frameBuilding(inset);
    if (selection.kind === 'department') {
      const place = placeOf(selection.id);
      return place ? rig.frame(place.corners(), 1.12, inset) : null;
    }
    const avatar = avatars.get(selection.id);
    if (!avatar) return null;
    // The desk a little below the middle, so the full bubble above the head fits too.
    return rig.frameAt(avatar.seatPoint(new THREE.Vector3()).addScaledVector(rig.up, 0.6), 2.7, inset);
  }

  function refocus(animate: boolean): void {
    let goal = frameFor(focusSel);
    if (!goal && focusSel?.kind === 'department') {
      // The department is gone (another project was opened): show the whole building again, not the empty
      // place where the room was.
      focusSel = null;
      goal = frameFor(null);
    }
    if (!goal) return;
    rig.setGoal(goal.target, goal.half, animate);
    requestRender();
  }

  function focus(selection: Selection, options?: { animate?: boolean }): void {
    if (selection && !frameFor(selection)) return;
    focusSel = selection;
    following = true;
    refocus((options?.animate ?? true) && !reduced);
  }

  const probeObserver = new ResizeObserver(() => {
    if (following && !disposed) refocus(framed && !reduced);
  });
  probeObserver.observe(safeProbe);

  // Highlights and bubbles.

  function frameGeometry(room: Room | Reception): THREE.BufferGeometry {
    const r = room.carpetRect();
    const b = new GeoBuilder();
    if (r) {
      const t = 0.07;
      const y0 = r.y;
      const y1 = r.y + 0.006;
      b.slab(r.minX, r.minZ, r.maxX, r.minZ + t, y0, y1, '#ffffff');
      b.slab(r.minX, r.maxZ - t, r.maxX, r.maxZ, y0, y1, '#ffffff');
      b.slab(r.minX, r.minZ + t, r.minX + t, r.maxZ - t, y0, y1, '#ffffff');
      b.slab(r.maxX - t, r.minZ + t, r.maxX, r.maxZ - t, y0, y1, '#ffffff');
    }
    return b.build();
  }

  function setFrame(mesh: THREE.Mesh, room: Room | Reception | undefined): void {
    mesh.geometry.dispose();
    mesh.geometry = room ? frameGeometry(room) : new THREE.BufferGeometry();
    mesh.visible = room !== undefined;
  }

  function applyHighlights(): void {
    const selectedRoom = selected?.kind === 'department' ? placeOf(selected.id) : undefined;
    const hoveredRoom = hovered?.kind === 'department' ? placeOf(hovered.id) : undefined;
    setFrame(selectFrame, selectedRoom);
    setFrame(hoverFrame, hoveredRoom !== selectedRoom ? hoveredRoom : undefined);
    placeRings();
    applyBubbleModes();
    requestRender();
  }

  function placeRings(): void {
    const ring = (mesh: THREE.Mesh, selection: Selection, skip?: Selection) => {
      const avatar = selection?.kind === 'agent' ? avatars.get(selection.id) : undefined;
      const same = skip?.kind === 'agent' && selection?.kind === 'agent' && skip.id === selection.id;
      mesh.visible = avatar !== undefined && avatar.pickable && !same;
      if (avatar && mesh.visible) {
        avatar.center(mesh.position);
        mesh.position.y = avatar.room.floorY + 0.016;
      }
    };
    ring(selectRing, selected);
    ring(hoverRing, hovered, selected);
  }

  function applyBubbleModes(): void {
    const focusedRoom =
      selected?.kind === 'department' ? selected.id : selected?.kind === 'agent' ? (avatars.get(selected.id)?.agent.department ?? null) : null;
    for (const avatar of avatars.values()) {
      if (!avatar.pickable) {
        avatar.bubble.setMode('hidden');
        continue;
      }
      const emphasized =
        (hovered?.kind === 'agent' && hovered.id === avatar.id) || (selected?.kind === 'agent' && selected.id === avatar.id);
      const full = emphasized || close || avatar.agent.department === focusedRoom;
      const quiet = avatar.agent.kind === 'manager' && avatar.agent.status === 'idle';
      avatar.bubble.setMode(full ? 'full' : quiet ? 'hidden' : 'chip');
      avatar.bubble.object.renderOrder = emphasized ? 1 : 0;
    }
  }

  function setHover(next: Selection): void {
    if (next?.kind === hovered?.kind && next?.id === hovered?.id) return;
    hovered = next;
    container.style.cursor = next ? 'pointer' : '';
    applyHighlights();
  }

  // Picking and pointer input.

  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const floorPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -FLOOR_Y);
  const sphere = new THREE.Sphere(new THREE.Vector3(), 0.42);
  const hit = new THREE.Vector3();

  /** An avatar was hit. The general manager at the reception stands for its department: it has no room to open. */
  function pickAvatar(avatar: Avatar): Selection {
    if (avatar.agent.kind === 'manager' && avatar.room instanceof Reception) return { kind: 'department', id: avatar.room.id };
    return { kind: 'agent', id: avatar.id };
  }

  function pick(clientX: number, clientY: number, target: EventTarget | null): Selection {
    const el = target instanceof Element ? target : null;
    const agentId = el?.closest<HTMLElement>('[data-office-agent]')?.dataset.officeAgent;
    const clicked = agentId ? avatars.get(agentId) : undefined;
    if (clicked?.pickable) return pickAvatar(clicked);
    const deptId = el?.closest<HTMLElement>('[data-office-dept]')?.dataset.officeDept;
    if (deptId && placeOf(deptId)) return { kind: 'department', id: deptId };

    const rect = container.getBoundingClientRect();
    ndc.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    raycaster.setFromCamera(ndc, rig.camera);
    let best: Avatar | null = null;
    let bestDistance = Infinity;
    for (const avatar of avatars.values()) {
      if (!avatar.pickable) continue;
      avatar.center(sphere.center);
      if (!raycaster.ray.intersectSphere(sphere, hit)) continue;
      const distance = hit.distanceToSquared(raycaster.ray.origin);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = avatar;
      }
    }
    if (best) return pickAvatar(best);
    for (const reception of receptions.values()) if (reception.hit(raycaster.ray)) return { kind: 'department', id: reception.id };
    if (raycaster.ray.intersectPlane(floorPlane, hit)) {
      for (const room of rooms.values()) if (room.contains(hit.x, hit.z)) return { kind: 'department', id: room.id };
    }
    return null;
  }

  /** A click in the scene: frame what was clicked and tell the listeners. */
  function choose(selection: Selection): void {
    if (selection === null && selected === null) return;
    focus(selection, { animate: true });
    for (const listener of listeners) listener(selection);
  }

  let drag: { id: number; x: number; y: number; startX: number; startY: number; target: EventTarget | null; moved: boolean } | null = null;

  function onPointerDown(event: PointerEvent): void {
    if (event.button !== 0 || drag) return;
    drag = { id: event.pointerId, x: event.clientX, y: event.clientY, startX: event.clientX, startY: event.clientY, target: event.target, moved: false };
  }

  function onPointerMove(event: PointerEvent): void {
    if (drag && event.pointerId === drag.id) {
      if (!drag.moved && Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) > CLICK_SLOP_PX) {
        drag.moved = true;
        container.setPointerCapture(event.pointerId);
        setHover(null);
        container.style.cursor = 'grabbing';
      }
      if (drag.moved) {
        rig.pan(event.clientX - drag.x, event.clientY - drag.y, container.clientHeight);
        following = false;
        requestRender();
      }
      drag.x = event.clientX;
      drag.y = event.clientY;
      return;
    }
    if (event.pointerType === 'mouse') setHover(pick(event.clientX, event.clientY, event.target));
  }

  function onPointerUp(event: PointerEvent): void {
    if (!drag || event.pointerId !== drag.id) return;
    const { moved, target } = drag;
    drag = null;
    if (container.hasPointerCapture(event.pointerId)) container.releasePointerCapture(event.pointerId);
    container.style.cursor = hovered ? 'pointer' : '';
    if (!moved) choose(pick(event.clientX, event.clientY, target));
  }

  function onPointerCancel(event: PointerEvent): void {
    if (drag && event.pointerId === drag.id) drag = null;
    container.style.cursor = hovered ? 'pointer' : '';
  }

  function onPointerLeave(): void {
    if (!drag) setHover(null);
  }

  function onWheel(event: WheelEvent): void {
    event.preventDefault();
    const rect = container.getBoundingClientRect();
    const nx = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    const ny = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? rect.height : 1;
    const delta = THREE.MathUtils.clamp(event.deltaY * unit, -400, 400);
    rig.zoomAt(Math.exp(delta * (event.ctrlKey ? 0.01 : 0.0016)), nx, ny);
    following = false;
    requestRender();
  }

  function onMotionChange(): void {
    api.setReducedMotion(motionQuery.matches);
  }

  container.addEventListener('pointerdown', onPointerDown);
  container.addEventListener('pointermove', onPointerMove);
  container.addEventListener('pointerup', onPointerUp);
  container.addEventListener('pointercancel', onPointerCancel);
  container.addEventListener('pointerleave', onPointerLeave);
  container.addEventListener('wheel', onWheel, { passive: false });
  motionQuery.addEventListener('change', onMotionChange);

  // The elapsed time in the bubbles moves on without a frame: it is only text.
  const ticker = window.setInterval(() => {
    const now = Date.now();
    for (const avatar of avatars.values()) avatar.bubble.tick(now);
  }, 1000);

  function resize(): void {
    const width = Math.max(1, container.clientWidth);
    const height = Math.max(1, container.clientHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO));
    renderer.setSize(width, height);
    labelLayer.setSize(width, height);
    bubbleLayer.setSize(width, height);
    rig.setViewport(width, height);
    rig.maxHalf = Math.max(14, frameBuilding(NO_INSET).half * 1.7);
    if (following) refocus(false);
    requestRender();
  }

  const api: OfficeScene = {
    focus,
    resize,
    setReducedMotion(on) {
      if (reduced === on) return;
      reduced = on;
      requestRender();
    },
    onSelect(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    stats(): SceneStats {
      const now = performance.now();
      while (frames.length > 0 && frames[0].at < now - 1000) frames.shift();
      const last = frames[frames.length - 1];
      let calls = 0;
      let triangles = 0;
      for (const f of frames) {
        calls = Math.max(calls, f.calls);
        triangles = Math.max(triangles, f.triangles);
      }
      return {
        drawCalls: frames.length > 0 ? calls : (last?.calls ?? renderer.info.render.calls),
        triangles: frames.length > 0 ? triangles : (last?.triangles ?? renderer.info.render.triangles),
        fps: frames.length,
      };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      cancelAnimationFrame(raf);
      window.clearInterval(ticker);
      probeObserver.disconnect();
      unsubscribe();
      listeners.clear();
      container.removeEventListener('pointerdown', onPointerDown);
      container.removeEventListener('pointermove', onPointerMove);
      container.removeEventListener('pointerup', onPointerUp);
      container.removeEventListener('pointercancel', onPointerCancel);
      container.removeEventListener('pointerleave', onPointerLeave);
      container.removeEventListener('wheel', onWheel);
      motionQuery.removeEventListener('change', onMotionChange);
      container.style.cursor = '';
      for (const avatar of avatars.values()) avatar.dispose();
      avatars.clear();
      for (const room of rooms.values()) room.dispose();
      rooms.clear();
      for (const reception of receptions.values()) reception.dispose();
      receptions.clear();
      shell.dispose();
      parts.dispose();
      for (const batch of batches) {
        batch.dispose();
        batch.geometry.dispose();
      }
      for (const mesh of [hoverFrame, selectFrame]) mesh.geometry.dispose();
      ringShape.dispose();
      for (const mesh of [hoverFrame, selectFrame, hoverRing, selectRing]) (mesh.material as THREE.Material).dispose();
      shellMaterial.dispose();
      propMaterial.dispose();
      kit.plants.material.dispose();
      screenMaterial.dispose();
      ground.geometry.dispose();
      (ground.material as THREE.Material).dispose();
      grid.geometry.dispose();
      gridMaterial.dispose();
      sun.shadow.map?.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      renderer.domElement.remove();
      labelLayer.domElement.remove();
      bubbleLayer.domElement.remove();
      safeProbe.remove();
    },
  };

  resize();
  sync(store.getState(), null);
  const unsubscribe = store.subscribe((state, previous) => sync(state, previous));
  return api;
};
