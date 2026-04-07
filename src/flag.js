export function createFlag(scene, options = {}) {
  const {
    position = new BABYLON.Vector3(0, 0, 0),
    color = new BABYLON.Color3(1, 1, 1)
  } = options;

  // ROOT (so game can move it)
  const root = new BABYLON.TransformNode("flagRoot", scene);
  root.position.copyFrom(position);

  // POLE
  const pole = BABYLON.MeshBuilder.CreateCylinder("pole", {
    height: 5,
    diameter: 0.1
  }, scene);
  pole.parent = root;

  const poleMat = new BABYLON.StandardMaterial("pm", scene);
  poleMat.diffuseColor = new BABYLON.Color3(0.2, 0.2, 0.25);
  pole.material = poleMat;

  // ================= FLAG SIM =================
  const W = 4, H = 2.5, SEG = 4;
  const idx = (x, y) => y * (SEG + 1) + x;

  const pts = [];

  for (let y = 0; y <= SEG; y++) {
    for (let x = 0; x <= SEG; x++) {

      const px = (x / SEG) * W;
      const py = (y / SEG - 0.5) * H + 1.2;

      pts.push({
        p: new BABYLON.Vector3(px, py, 0),
        prev: new BABYLON.Vector3(px, py, 0),
        pinned: x === 0
      });
    }
  }

  const tris = [];
  for (let y = 0; y < SEG; y++) {
    for (let x = 0; x < SEG; x++) {
      const a = idx(x, y), b = idx(x + 1, y),
            c = idx(x, y + 1), d = idx(x + 1, y + 1);

      tris.push([a, c, b]);
      tris.push([b, c, d]);
    }
  }

  const mesh = new BABYLON.Mesh("flagMesh", scene);
  mesh.parent = root;

  let pos = [], ind = [], col = [];
  let i = 0;

  for (let t of tris) {
    for (let k = 0; k < 3; k++) {
      const p = pts[t[k]].p;
      pos.push(p.x, p.y, p.z);
      col.push(color.r, color.g, color.b);
      ind.push(i++);
    }
  }

  const vd = new BABYLON.VertexData();
  vd.positions = pos;
  vd.indices = ind;
  vd.colors = col;
  vd.applyToMesh(mesh, true);

  const mat = new BABYLON.StandardMaterial("m", scene);
  mat.vertexColorEnabled = true;
  mat.backFaceCulling = false;
  mesh.material = mat;

  mesh.convertToFlatShadedMesh();

  // ================= SIM =================
  const wStep = W / SEG;
  const hStep = H / SEG;
  const wind = 0.35;
  const damping = 0.92;

  function solve(a, b, rest) {
    const d = b.p.subtract(a.p);
    const len = d.length();
    if (!len) return;

    const diff = (len - rest) / len;
    const corr = d.scale(diff * 0.5 * 0.9);

    if (!a.pinned) a.p.addInPlace(corr);
    if (!b.pinned) b.p.subtractInPlace(corr);
  }

  function step() {
    const t = performance.now() * 0.002;

    for (const p of pts) {
      if (p.pinned) continue;

      let v = p.p.subtract(p.prev).scale(damping);
      p.prev.copyFrom(p.p);
      p.p.addInPlace(v);

      const wave =
        Math.sin(p.p.x * 2 - t * 2) +
        Math.cos(p.p.y * 3 + t * 2) * 0.3;

      const edge = (p.p.x + W / 2) / W;
      p.p.z = wave * wind * edge;
    }

    for (let it = 0; it < 4; it++) {
      for (let y = 0; y <= SEG; y++) {
        for (let x = 0; x <= SEG; x++) {
          const a = pts[idx(x, y)];
          if (x < SEG) solve(a, pts[idx(x + 1, y)], wStep);
          if (y < SEG) solve(a, pts[idx(x, y + 1)], hStep);
        }
      }
    }
  }

  function updateMesh() {
    let i = 0;
    for (const t of tris) {
      for (let k = 0; k < 3; k++) {
        const p = pts[t[k]].p;
        pos[i++] = p.x;
        pos[i++] = p.y;
        pos[i++] = p.z;
      }
    }

    mesh.updateVerticesData(BABYLON.VertexBuffer.PositionKind, pos);
  }

  // ================= PUBLIC API =================
  return {
    root,
    mesh,

    update() {
      step();
      updateMesh();
    },

    setPosition(v) {
      root.position.copyFrom(v);
    },

    attachTo(mesh) {
      root.parent = mesh;
    }
  };
}
