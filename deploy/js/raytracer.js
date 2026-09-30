/**
 * Ray tracing engine for light guide simulation.
 * Uses global THREE (loaded via classic script tag).
 */
class RayTracer {
  constructor(mesh, options) {
    options = options || {};
    this.mesh = mesh;
    this.geometry = mesh.geometry;
    this.n = options.n || 1.586;
    this.alpha = options.alpha || 0.40;
    this.maxBounces = options.maxBounces || 20;
    this.numRays = options.numRays || 100;
    this.angleSigma = options.angleSigma || 15;
    this.posSigma = options.posSigma || 0.3;
    this.inputFaceIds = options.inputFaceIds || [];
    this.outputFaceIds = options.outputFaceIds || [];
    this._buildFaceData();
    this._computeGridSize();
  }

  _computeGridSize() {
    var pos = this.geometry.attributes.position.array;
    var mn = [1e9, 1e9, 1e9], mx = [-1e9, -1e9, -1e9];
    for (var i = 0; i < pos.length; i += 3) {
      for (var j = 0; j < 3; j++) {
        if (pos[i + j] < mn[j]) mn[j] = pos[i + j];
        if (pos[i + j] > mx[j]) mx[j] = pos[i + j];
      }
    }
    this.gridSize = Math.max(mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]);
    if (this.gridSize < 0.001) this.gridSize = 1.0;
  }

  _buildFaceData() {
    var geo = this.geometry;
    var pos = geo.attributes.position;
    var index = geo.index;
    this.faces = [];
    this.faceNormals = [];
    this.faceCenters = [];
    this.faceAreas = [];

    var vA = new THREE.Vector3(), vB = new THREE.Vector3(), vC = new THREE.Vector3();
    var edge1 = new THREE.Vector3(), edge2 = new THREE.Vector3();
    var normal = new THREE.Vector3();

    var faceCount = index ? index.count / 3 : pos.count / 3;
    for (var i = 0; i < faceCount; i++) {
      var a = index ? index.getX(i * 3) : i * 3;
      var b = index ? index.getX(i * 3 + 1) : i * 3 + 1;
      var c = index ? index.getX(i * 3 + 2) : i * 3 + 2;
      vA.fromBufferAttribute(pos, a);
      vB.fromBufferAttribute(pos, b);
      vC.fromBufferAttribute(pos, c);
      edge1.subVectors(vB, vA);
      edge2.subVectors(vC, vA);
      normal.crossVectors(edge1, edge2);
      var area = normal.length() * 0.5;
      normal.normalize();
      this.faces.push({a: vA.clone(), b: vB.clone(), c: vC.clone()});
      this.faceNormals.push(normal.clone());
      this.faceCenters.push(new THREE.Vector3().add(vA).add(vB).add(vC).multiplyScalar(1/3));
      this.faceAreas.push(area);
    }
    this._buildGrid();
  }

  _buildGrid() {
    var bbox = new THREE.Box3();
    for (var i = 0; i < this.faces.length; i++) {
      bbox.expandByPoint(this.faces[i].a);
      bbox.expandByPoint(this.faces[i].b);
      bbox.expandByPoint(this.faces[i].c);
    }
    this.bbox = bbox;
    var size = new THREE.Vector3();
    bbox.getSize(size);
    var maxDim = Math.max(size.x, size.y, size.z);
    var cellSize = maxDim / 30;
    this.gridCellSize = cellSize;
    this.gridOrigin = bbox.min.clone();
    var nx = Math.ceil(size.x / cellSize) + 1;
    var ny = Math.ceil(size.y / cellSize) + 1;
    var nz = Math.ceil(size.z / cellSize) + 1;
    this.gridDims = {nx: nx, ny: ny, nz: nz};
    this.grid = new Map();
    for (var i = 0; i < this.faces.length; i++) {
      var c = this.faceCenters[i];
      var gx = Math.floor((c.x - this.gridOrigin.x) / cellSize);
      var gy = Math.floor((c.y - this.gridOrigin.y) / cellSize);
      var gz = Math.floor((c.z - this.gridOrigin.z) / cellSize);
      var key = gx + ',' + gy + ',' + gz;
      if (!this.grid.has(key)) this.grid.set(key, []);
      this.grid.get(key).push(i);
    }
  }

  _getNearbyFaces(point) {
    var gx = Math.floor((point.x - this.gridOrigin.x) / this.gridCellSize);
    var gy = Math.floor((point.y - this.gridOrigin.y) / this.gridCellSize);
    var gz = Math.floor((point.z - this.gridOrigin.z) / this.gridCellSize);
    var result = [];
    for (var dx = -2; dx <= 2; dx++)
      for (var dy = -2; dy <= 2; dy++)
        for (var dz = -2; dz <= 2; dz++) {
          var key = (gx+dx) + ',' + (gy+dy) + ',' + (gz+dz);
          if (this.grid.has(key)) {
            var arr = this.grid.get(key);
            for (var k = 0; k < arr.length; k++) result.push(arr[k]);
          }
        }
    return result;
  }

  _rayTriangle(origin, dir, face) {
    var eps = 1e-9;
    var edge1 = new THREE.Vector3().subVectors(face.b, face.a);
    var edge2 = new THREE.Vector3().subVectors(face.c, face.a);
    var h = new THREE.Vector3().crossVectors(dir, edge2);
    var a = edge1.dot(h);
    if (a > -eps && a < eps) return null;
    var f = 1 / a;
    var s = new THREE.Vector3().subVectors(origin, face.a);
    var u = f * s.dot(h);
    if (u < 0 || u > 1) return null;
    var q = new THREE.Vector3().crossVectors(s, edge1);
    var v = f * dir.dot(q);
    if (v < 0 || u + v > 1) return null;
    var t = f * edge2.dot(q);
    if (t > eps) return {t: t, u: u, v: v};
    return null;
  }

  _raycast(origin, dir, excludeSet) {
    var nearest = null;
    var nearestFaceIdx = -1;
    for (var idx = 0; idx < this.faces.length; idx++) {
      if (excludeSet && excludeSet.has(idx)) continue;
      var hit = this._rayTriangle(origin, dir, this.faces[idx]);
      if (hit && (nearest === null || hit.t < nearest.t)) {
        nearest = hit;
        nearestFaceIdx = idx;
      }
    }
    return nearest ? {t: nearest.t, u: nearest.u, v: nearest.v, faceIdx: nearestFaceIdx} : null;
  }

  _refract(incident, normal, n1, n2) {
    var eta = n1 / n2;
    var cosI = -incident.dot(normal);
    var sinT2 = eta * eta * (1 - cosI * cosI);
    if (sinT2 > 1) return null;
    var cosT = Math.sqrt(1 - sinT2);
    return new THREE.Vector3().copy(incident).multiplyScalar(eta).add(normal.clone().multiplyScalar(eta * cosI - cosT)).normalize();
  }

  _reflect(incident, normal) {
    var dot = incident.dot(normal);
    return new THREE.Vector3().copy(incident).sub(normal.clone().multiplyScalar(2 * dot)).normalize();
  }

  _gaussian() {
    var u1 = Math.random();
    var u2 = Math.random();
    return Math.sqrt(-2 * Math.log(u1 + 1e-10)) * Math.cos(2 * Math.PI * u2);
  }

  _generateRays() {
    if (this.inputFaceIds.length === 0) return [];
    // Input face centroid
    var inCentroid = new THREE.Vector3();
    var inTotalArea = 0;
    for (var i = 0; i < this.inputFaceIds.length; i++) {
      var idx = this.inputFaceIds[i];
      inCentroid.add(this.faceCenters[idx].clone().multiplyScalar(this.faceAreas[idx]));
      inTotalArea += this.faceAreas[idx];
    }
    inCentroid.divideScalar(inTotalArea);
    // Input face normal (area-weighted)
    var avgNormal = new THREE.Vector3();
    for (var i = 0; i < this.inputFaceIds.length; i++) {
      var idx = this.inputFaceIds[i];
      avgNormal.add(this.faceNormals[idx].clone().multiplyScalar(this.faceAreas[idx]));
    }
    avgNormal.divideScalar(inTotalArea).normalize();
    // Determine inward direction using face NORMAL (perpendicular to face)
    // This ensures rays enter perpendicular to the input surface
    var inward = avgNormal.clone().negate();  // Default: opposite of outward normal
    // Raycast verification: check if -normal direction goes into mesh
    var inputSet = new Set(this.inputFaceIds);
    var probeOrigin = inCentroid.clone().add(inward.clone().multiplyScalar(0.005));
    var probeHit = this._raycast(probeOrigin, inward, inputSet);
    if (!probeHit) {
      // -normal didn't hit anything, try +normal
      var probeOrigin2 = inCentroid.clone().add(avgNormal.clone().multiplyScalar(0.005));
      var probeHit2 = this._raycast(probeOrigin2, avgNormal, inputSet);
      if (probeHit2) {
        inward = avgNormal.clone();  // +normal is the inward direction
        probeHit = probeHit2;
      }
    }
    // Build local coordinate system
    var up = Math.abs(inward.y) < 0.9 ? new THREE.Vector3(0,1,0) : new THREE.Vector3(1,0,0);
    var right = new THREE.Vector3().crossVectors(up, inward).normalize();
    var realUp = new THREE.Vector3().crossVectors(inward, right).normalize();
    // Max radius of input face
    var maxR = 0;
    for (var i = 0; i < this.inputFaceIds.length; i++) {
      var d = this.faceCenters[this.inputFaceIds[i]].clone().sub(inCentroid);
      var r = Math.sqrt(d.dot(d));
      if (r > maxR) maxR = r;
    }
    maxR = Math.max(maxR, 0.001);
    var rays = [];
    var sigmaRad = this.angleSigma * Math.PI / 180;
    var posSpread = maxR * this.posSigma;
    for (var i = 0; i < this.numRays; i++) {
      var px = this._gaussian() * posSpread;
      var py = this._gaussian() * posSpread;
      var origin = inCentroid.clone().add(right.clone().multiplyScalar(px)).add(realUp.clone().multiplyScalar(py));
      var dx = this._gaussian() * sigmaRad;
      var dy = this._gaussian() * sigmaRad;
      var dir = inward.clone().add(right.clone().multiplyScalar(dx)).add(realUp.clone().multiplyScalar(dy)).normalize();
      var initOffset = 0.005 * (this.gridSize || 4.0);
      origin.add(dir.clone().multiplyScalar(initOffset));
      rays.push({origin: origin, dir: dir});
    }
    console.log('RayGen: inward=(' + inward.x.toFixed(3) + ',' + inward.y.toFixed(3) + ',' + inward.z.toFixed(3) + ') probeHit=' + (probeHit ? probeHit.t.toFixed(3) : 'null') + ' rays=' + rays.length);
    return rays;
  }

  _traceRay(ray) {
    // First pass: trace ray and collect raw segments (no color yet)
    var rawSegments = [];
    var origin = ray.origin.clone();
    var dir = ray.dir.clone();
    var inside = true;
    var bounces = 0;
    var hitOutput = false;
    var escaped = false;
    var outputSet = new Set(this.outputFaceIds);
    var prevHitFaces = new Set();
    var maxDim = this.gridSize || 4.0;
    var offset = 0.003 * maxDim;
    var escapeSegment = null;
    while (bounces < this.maxBounces) {
      var exclude = new Set(prevHitFaces);
      // Also exclude input faces - rays should never hit input face from inside
      for (var fi = 0; fi < this.inputFaceIds.length; fi++) exclude.add(this.inputFaceIds[fi]);
      var hit = this._raycast(origin, dir, exclude);
      if (!hit) { escaped = true; break; }
      var hitPoint = origin.clone().add(dir.clone().multiplyScalar(hit.t));
      var faceNormal = this.faceNormals[hit.faceIdx];
      if (outputSet.has(hit.faceIdx)) {
        rawSegments.push({start: origin.clone(), end: hitPoint.clone()});
        hitOutput = true;
        // Add short external segment showing ray exiting through output face
        var exitEnd = hitPoint.clone().add(dir.clone().multiplyScalar(maxDim * 0.08));
        escapeSegment = {start: hitPoint.clone(), end: exitEnd};
        break;
      }
      var normal = faceNormal.clone();
      if (normal.dot(dir) > 0) normal.negate();
      var n1 = inside ? this.n : 1.0;
      var n2 = inside ? 1.0 : this.n;
      var refracted = this._refract(dir, normal, n1, n2);
      prevHitFaces.clear();
      prevHitFaces.add(hit.faceIdx);
      // If ray hits input face from inside, force TIR (don't escape through input)
      var inputSet = new Set(this.inputFaceIds);
      if (refracted && inside && inputSet.has(hit.faceIdx)) {
        refracted = null;  // Force TIR instead of escaping through input face
      }
      if (refracted) {
        rawSegments.push({start: origin.clone(), end: hitPoint.clone()});
        if (inside) {
          escaped = true;
          var escapeEnd = hitPoint.clone().add(refracted.clone().multiplyScalar(maxDim * 0.15));
          escapeSegment = {start: hitPoint.clone(), end: escapeEnd};
          break;
        } else {
          inside = true;
        }
        dir = refracted;
        origin = hitPoint.clone().add(dir.clone().multiplyScalar(offset));
      } else {
        rawSegments.push({start: origin.clone(), end: hitPoint.clone()});
        dir = this._reflect(dir, normal);
        origin = hitPoint.clone().add(dir.clone().multiplyScalar(offset));
      }
      bounces++;
    }
    // Second pass: assign colors based on FINAL outcome
    var segments = [];
    if (hitOutput) {
      // Success: entire path is crimson, including exit segment
      for (var i = 0; i < rawSegments.length; i++) {
        segments.push({start: rawSegments[i].start, end: rawSegments[i].end, type: 'success'});
      }
      if (escapeSegment) {
        segments.push({start: escapeSegment.start, end: escapeSegment.end, type: 'success'});
      }
    } else if (escaped) {
      // Escaped: internal = indigo, external = orange
      for (var i = 0; i < rawSegments.length; i++) {
        segments.push({start: rawSegments[i].start, end: rawSegments[i].end, type: 'in-body'});
      }
      if (escapeSegment) {
        segments.push({start: escapeSegment.start, end: escapeSegment.end, type: 'escape'});
      }
    } else {
      // Exhausted: all indigo
      for (var i = 0; i < rawSegments.length; i++) {
        segments.push({start: rawSegments[i].start, end: rawSegments[i].end, type: 'in-body'});
      }
    }
    return {segments: segments, hitOutput: hitOutput, escaped: escaped, bounces: bounces};
  }

  simulate() {
    var rays = this._generateRays();
    var results = {total: rays.length, success: 0, escaped: 0, exhausted: 0, segments: []};
    for (var i = 0; i < rays.length; i++) {
      var result = this._traceRay(rays[i]);
      for (var j = 0; j < result.segments.length; j++) results.segments.push(result.segments[j]);
      if (result.hitOutput) results.success++;
      else if (result.escaped) results.escaped++;
      else results.exhausted++;
    }
    results.successRate = results.total > 0 ? (results.success / results.total * 100).toFixed(1) : 0;
    return results;
  }

  static autoDetectEndCaps(faces, normals, centers, areas) {
    if (faces.length === 0) return {input: [], output: []};
    var cx = 0, cy = 0, cz = 0;
    for (var i = 0; i < centers.length; i++) { cx += centers[i].x; cy += centers[i].y; cz += centers[i].z; }
    cx /= centers.length; cy /= centers.length; cz /= centers.length;
    var varX = 0, varY = 0, varZ = 0;
    for (var i = 0; i < centers.length; i++) {
      varX += (centers[i].x - cx) ** 2;
      varY += (centers[i].y - cy) ** 2;
      varZ += (centers[i].z - cz) ** 2;
    }
    var axisIdx;
    if (varX >= varY && varX >= varZ) axisIdx = 0;
    else if (varY >= varZ) axisIdx = 1;
    else axisIdx = 2;
    var axisVals = centers.map(function(c) { return [c.x, c.y, c.z][axisIdx]; });
    var minVal = Math.min.apply(null, axisVals);
    var maxVal = Math.max.apply(null, axisVals);
    var range = maxVal - minVal;
    var threshold = range * 0.05;
    var endGroups = {min: [], max: []};
    for (var i = 0; i < faces.length; i++) {
      var n = normals[i];
      var axisComp = Math.abs([n.x, n.y, n.z][axisIdx]);
      if (axisComp < 0.7) continue;
      var val = [centers[i].x, centers[i].y, centers[i].z][axisIdx];
      if (Math.abs(val - minVal) < threshold) endGroups.min.push(i);
      else if (Math.abs(val - maxVal) < threshold) endGroups.max.push(i);
    }
    var input = endGroups.max.length >= endGroups.min.length ? endGroups.max : endGroups.min;
    var output = endGroups.max.length >= endGroups.min.length ? endGroups.min : endGroups.max;
    return {input: input, output: output};
  }

  static expandPlanar(faces, normals, centers, adjacency, seedIdx, angleThreshold, distThreshold) {
    angleThreshold = angleThreshold || 22;
    distThreshold = distThreshold || 0.08;
    var seedNormal = normals[seedIdx];
    var seedCenter = centers[seedIdx];
    var visited = new Set([seedIdx]);
    var queue = [seedIdx];
    var result = [seedIdx];
    var seedPlaneD = seedNormal.dot(seedCenter);
    var maxDim = 0;
    for (var i = 0; i < centers.length; i++) {
      maxDim = Math.max(maxDim, Math.abs(centers[i].x), Math.abs(centers[i].y), Math.abs(centers[i].z));
    }
    var distLimit = maxDim * distThreshold;
    while (queue.length > 0) {
      var curr = queue.shift();
      var neighbors = adjacency.get(curr) || [];
      for (var i = 0; i < neighbors.length; i++) {
        var nb = neighbors[i];
        if (visited.has(nb)) continue;
        visited.add(nb);
        var dot = seedNormal.dot(normals[nb]);
        var angle = Math.acos(Math.max(-1, Math.min(1, dot))) * 180 / Math.PI;
        var planeDist = Math.abs(seedNormal.dot(centers[nb]) - seedPlaneD);
        if (angle < angleThreshold && planeDist < distLimit) {
          result.push(nb);
          queue.push(nb);
        }
      }
    }
    return result;
  }

  static buildAdjacency(faces) {
    var adjacency = new Map();
    var vertexMap = new Map();
    for (var i = 0; i < faces.length; i++) {
      var f = faces[i];
      var verts = [f.a, f.b, f.c];
      for (var vi = 0; vi < verts.length; vi++) {
        var key = verts[vi].x.toFixed(5) + ',' + verts[vi].y.toFixed(5) + ',' + verts[vi].z.toFixed(5);
        if (!vertexMap.has(key)) vertexMap.set(key, []);
        vertexMap.get(key).push(i);
      }
    }
    vertexMap.forEach(function(faceIndices, key) {
      for (var i = 0; i < faceIndices.length; i++) {
        for (var j = i + 1; j < faceIndices.length; j++) {
          var a = faceIndices[i], b = faceIndices[j];
          if (!adjacency.has(a)) adjacency.set(a, []);
          if (!adjacency.has(b)) adjacency.set(b, []);
          if (adjacency.get(a).indexOf(b) === -1) adjacency.get(a).push(b);
          if (adjacency.get(b).indexOf(a) === -1) adjacency.get(b).push(a);
        }
      }
    });
    return adjacency;
  }
}
