/**
 * Light Guide Simulation - Web Application (classic script)
 * Uses global THREE, THREE.OrbitControls, THREE.STLLoader, THREE.OBJLoader
 */
(function() {
  'use strict';

  var scene, camera, renderer, controls;
  var mesh = null, meshGeometry = null;
  var faces = [], faceNormals = [], faceCenters = [], faceAreas = [];
  var adjacency = new Map();
  var inputFaceIds = [], outputFaceIds = [];
  var bufferFaceIds = new Set();
  var selectionMode = false;
  var rayLines = null;
  var highlightMeshes = {input: null, output: null, buffer: null};
  var raycaster = new THREE.Raycaster();
  var mouse = new THREE.Vector2();

  function init() {
    var container = document.getElementById('viewer');
    if (!container) { console.error('viewer container not found'); return; }

    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x1a1a2e);

    var w = container.clientWidth || 800;
    var h = container.clientHeight || 600;
    camera = new THREE.PerspectiveCamera(50, w / h, 0.01, 1000);
    camera.position.set(5, 3, 5);

    renderer = new THREE.WebGLRenderer({antialias: true});
    renderer.setSize(w, h);
    renderer.setPixelRatio(window.devicePixelRatio);
    container.appendChild(renderer.domElement);

    controls = new THREE.OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;

    scene.add(new THREE.AmbientLight(0xffffff, 0.6));
    var dirLight = new THREE.DirectionalLight(0xffffff, 0.8);
    dirLight.position.set(5, 10, 7);
    scene.add(dirLight);
    var dirLight2 = new THREE.DirectionalLight(0x88aaff, 0.3);
    dirLight2.position.set(-5, -3, -5);
    scene.add(dirLight2);

    var grid = new THREE.GridHelper(10, 20, 0x333366, 0x222244);
    grid.position.y = -0.01;
    scene.add(grid);

    // Events
    window.addEventListener('resize', onResize);

    var btnUpload = document.getElementById('btn-upload');
    var fileInput = document.getElementById('file-input');
    if (!btnUpload || !fileInput) { console.error('upload elements not found'); return; }

    btnUpload.addEventListener('click', function() {
      console.log('upload button clicked');
      fileInput.click();
    });
    fileInput.addEventListener('change', function(e) {
      if (e.target.files.length > 0) loadFile(e.target.files[0]);
    });

    // Material select
    var matSelect = document.getElementById('material-select');
    var paramN = document.getElementById('param-n');
    var paramAlpha = document.getElementById('param-alpha');
    if (matSelect) {
      matSelect.addEventListener('change', function(e) {
        if (e.target.value === 'custom') return;
        var parts = e.target.value.split(',');
        paramN.value = parseFloat(parts[0]).toFixed(3);
        paramAlpha.value = parseFloat(parts[1]).toFixed(2);
      });
    }
    if (paramN) paramN.addEventListener('input', function() { matSelect.value = 'custom'; });
    if (paramAlpha) paramAlpha.addEventListener('input', function() { matSelect.value = 'custom'; });

    // Sliders
    bindSlider('slider-angle', 'lbl-angle');
    bindSlider('slider-pos', 'lbl-pos');
    bindSlider('slider-rays', 'lbl-rays');
    bindSlider('slider-bounces', 'lbl-bounces');

    // Buttons
    var btnAuto = document.getElementById('btn-auto');
    var btnClear = document.getElementById('btn-clear-sel');
    var btnSim = document.getElementById('btn-simulate');
    var btnReset = document.getElementById('btn-reset');
    if (btnAuto) btnAuto.addEventListener('click', autoSelectFaces);
    if (btnClear) btnClear.addEventListener('click', clearSelection);
    if (btnSim) btnSim.addEventListener('click', runSimulation);
    if (btnReset) btnReset.addEventListener('click', resetView);

    // Face picking
    renderer.domElement.addEventListener('click', function(e) {
      if (!selectionMode) return;
      var rect = renderer.domElement.getBoundingClientRect();
      mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(mouse, camera);
      if (!mesh) return;
      var intersects = raycaster.intersectObject(mesh, false);
      if (intersects.length > 0) {
        var faceIdx = intersects[0].faceIndex;
        if (e.ctrlKey || e.metaKey) {
          if (bufferFaceIds.has(faceIdx)) bufferFaceIds.delete(faceIdx);
          else bufferFaceIds.add(faceIdx);
        } else {
          var expanded = RayTracer.expandPlanar(faces, faceNormals, faceCenters, adjacency, faceIdx);
          for (var i = 0; i < expanded.length; i++) bufferFaceIds.add(expanded[i]);
        }
        updateBufferHighlight();
        updateStatus('Buffer: ' + bufferFaceIds.size + ' faces');
      }
    });

    // Keyboard
    window.addEventListener('keydown', function(e) {
      if (!selectionMode) return;
      var key = e.key.toLowerCase();
      if (key === 'i') {
        inputFaceIds = Array.from(bufferFaceIds);
        bufferFaceIds.clear();
        updateHighlights();
        updateStatus('Input set: ' + inputFaceIds.length + ' faces (blue)');
      } else if (key === 'o') {
        outputFaceIds = Array.from(bufferFaceIds);
        bufferFaceIds.clear();
        updateHighlights();
        updateStatus('Output set: ' + outputFaceIds.length + ' faces (yellow)');
      } else if (key === 'c') {
        bufferFaceIds.clear();
        updateBufferHighlight();
        updateStatus('Buffer cleared');
      } else if (key === 'enter' || key === 'q') {
        if (inputFaceIds.length > 0 && outputFaceIds.length > 0) {
          runSimulation();
        } else {
          updateStatus('Need both Input and Output faces selected!');
        }
      }
    });

    animate();
    updateStatus('Ready - Click "Choose File" to load a STEP/STL/OBJ file');
  }

  function bindSlider(sliderId, labelId) {
    var slider = document.getElementById(sliderId);
    var label = document.getElementById(labelId);
    if (slider && label) {
      slider.addEventListener('input', function() {
        label.textContent = slider.value;
      });
    }
  }

  function onResize() {
    var container = document.getElementById('viewer');
    if (!container || !camera || !renderer) return;
    camera.aspect = container.clientWidth / container.clientHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(container.clientWidth, container.clientHeight);
  }

  function animate() {
    requestAnimationFrame(animate);
    if (controls) controls.update();
    if (renderer && scene && camera) renderer.render(scene, camera);
  }

  function loadFile(file) {
    updateStatus('Loading file...');
    var ext = file.name.split('.').pop().toLowerCase();
    var url = URL.createObjectURL(file);
    try {
      if (ext === 'stl') {
        var loader = new THREE.STLLoader();
        loader.load(url, function(geometry) { onGeometryLoaded(geometry, file); },
          undefined, function(err) { updateStatus('Error: ' + err.message); });
      } else if (ext === 'obj') {
        var objLoader = new THREE.OBJLoader();
        objLoader.load(url, function(obj) {
          var geo = obj.children[0] ? obj.children[0].geometry : null;
          if (geo) onGeometryLoaded(geo, file);
          else updateStatus('Error: No geometry in OBJ');
        }, undefined, function(err) { updateStatus('Error: ' + err.message); });
      } else if (ext === 'step' || ext === 'stp') {
        loadSTEP(url, file);
      } else {
        updateStatus('Unsupported format: ' + ext);
      }
    } catch (err) {
      updateStatus('Error: ' + err.message);
      console.error(err);
    }
  }

  function onGeometryLoaded(geometry, file) {
    if (!geometry.attributes.position) { updateStatus('Error: No position data'); return; }
    geometry.computeBoundingBox();
    var center = new THREE.Vector3();
    geometry.boundingBox.getCenter(center);
    geometry.translate(-center.x, -center.y, -center.z);
    var size = new THREE.Vector3();
    geometry.boundingBox.getSize(size);
    var maxDim = Math.max(size.x, size.y, size.z, 0.001);
    var scale = 4 / maxDim;
    geometry.scale(scale, scale, scale);
    geometry.computeVertexNormals();

    if (mesh) scene.remove(mesh);
    clearRaySegments();
    clearHighlights();

    var material = new THREE.MeshPhongMaterial({
      color: 0xa0c0e0, transparent: true, opacity: 0.35, depthWrite: false,
      side: THREE.DoubleSide, flatShading: false, shininess: 30,
      specular: 0x222222
    });
    geometry.computeVertexNormals();
    mesh = new THREE.Mesh(geometry, material);
    scene.add(mesh);
    // Add wireframe overlay for better depth perception during face selection
    var wireGeo = new THREE.EdgesGeometry(geometry, 5);
    var wireMat = new THREE.LineBasicMaterial({color: 0x444444, transparent: true, opacity: 0.4, depthTest: false});
    var wireframe = new THREE.LineSegments(wireGeo, wireMat);
    mesh.add(wireframe);
    meshGeometry = geometry;
    buildFaceData();

    selectionMode = true;
    document.getElementById('btn-auto').disabled = false;
    document.getElementById('btn-clear-sel').disabled = false;
    document.getElementById('btn-simulate').disabled = false;
    document.getElementById('btn-reset').disabled = false;
    document.getElementById('instruction-overlay').style.display = 'block';
    document.getElementById('mode-indicator').textContent = 'Selecting';
    document.getElementById('mode-indicator').className = 'mode-badge selecting';
    document.getElementById('file-info').textContent = file.name + ' (' + (file.size / 1024).toFixed(1) + ' KB)';
    resetView();
    updateStatus('Loaded: ' + file.name + ' | ' + faces.length + ' faces | Click to select faces');
  }

  function loadSTEP(url, file) {
    updateStatus('Loading STEP parser (WASM)...');
    var occtCdn = 'https://cdn.jsdelivr.net/npm/occt-import-js@0.0.22/dist/';
    loadScript(occtCdn + 'occt-import-js.js', function() {
      if (typeof occtimportjs === 'undefined') { updateStatus('STEP parser failed to load'); return; }
      occtimportjs({
        locateFile: function(path) { return occtCdn + path; }
      }).then(function(occt) {
        fetch(url).then(function(r) { return r.arrayBuffer(); }).then(function(buf) {
          var result = occt.ReadStepFile(new Uint8Array(buf), null);
          if (!result || !result.success) { updateStatus('STEP parsing failed'); return; }
          var meshes = result.meshes || [];
          if (meshes.length === 0) { updateStatus('STEP: no meshes found'); return; }
          var positions = [];
          var indices = [];
          var vOffset = 0;
          for (var mi = 0; mi < meshes.length; mi++) {
            var mesh = meshes[mi];
            var posArr = mesh.attributes.position.array;
            for (var pi = 0; pi < posArr.length; pi++) positions.push(posArr[pi]);
            var idxArr = mesh.index ? mesh.index.array : null;
            if (idxArr) {
              for (var ii = 0; ii < idxArr.length; ii++) indices.push(idxArr[ii] + vOffset);
            } else {
              var numVerts = posArr.length / 3;
              for (var ii = 0; ii < numVerts; ii += 3) indices.push(ii + vOffset, ii+1+vOffset, ii+2+vOffset);
            }
            vOffset += posArr.length / 3;
          }
          var geo = new THREE.BufferGeometry();
          geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
          geo.setIndex(indices);
          onGeometryLoaded(geo, file);
        }).catch(function(err) { updateStatus('Error: ' + err.message); console.error(err); });
      }).catch(function(err) { updateStatus('WASM init error: ' + err.message); console.error(err); });
    }, function() { updateStatus('Failed to load STEP parser from CDN'); });
  }

  function loadScript(src, onload, onerror) {
    var s = document.createElement('script');
    s.src = src;
    s.onload = onload;
    s.onerror = onerror || function() { updateStatus('Failed to load: ' + src); };
    document.head.appendChild(s);
  }

  function buildFaceData() {
    var geo = meshGeometry;
    var pos = geo.attributes.position;
    var index = geo.index;
    faces = []; faceNormals = []; faceCenters = []; faceAreas = [];
    var vA = new THREE.Vector3(), vB = new THREE.Vector3(), vC = new THREE.Vector3();
    var edge1 = new THREE.Vector3(), edge2 = new THREE.Vector3();
    var normal = new THREE.Vector3();
    var count = index ? index.count / 3 : pos.count / 3;
    for (var i = 0; i < count; i++) {
      var a = index ? index.getX(i * 3) : i * 3;
      var b = index ? index.getX(i * 3 + 1) : i * 3 + 1;
      var c = index ? index.getX(i * 3 + 2) : i * 3 + 2;
      vA.fromBufferAttribute(pos, a); vB.fromBufferAttribute(pos, b); vC.fromBufferAttribute(pos, c);
      edge1.subVectors(vB, vA); edge2.subVectors(vC, vA);
      normal.crossVectors(edge1, edge2);
      var area = normal.length() * 0.5; normal.normalize();
      faces.push({a: vA.clone(), b: vB.clone(), c: vC.clone()});
      faceNormals.push(normal.clone());
      faceCenters.push(new THREE.Vector3().add(vA).add(vB).add(vC).multiplyScalar(1/3));
      faceAreas.push(area);
    }
    adjacency = RayTracer.buildAdjacency(faces);
    inputFaceIds = []; outputFaceIds = []; bufferFaceIds.clear();
  }

  function updateHighlights() {
    clearHighlights();
    if (inputFaceIds.length > 0) {
      highlightMeshes.input = createHighlightMesh(inputFaceIds, 0x3b82f6);
      scene.add(highlightMeshes.input);
    }
    if (outputFaceIds.length > 0) {
      highlightMeshes.output = createHighlightMesh(outputFaceIds, 0xeab308);
      scene.add(highlightMeshes.output);
    }
    updateBufferHighlight();
    updateSimButton();
  }

  function updateBufferHighlight() {
    if (highlightMeshes.buffer) { scene.remove(highlightMeshes.buffer); highlightMeshes.buffer = null; }
    if (bufferFaceIds.size > 0) {
      highlightMeshes.buffer = createHighlightMesh(Array.from(bufferFaceIds), 0x06b6d4);
      scene.add(highlightMeshes.buffer);
    }
  }

  function createHighlightMesh(faceIds, color) {
    var positions = [];
    for (var i = 0; i < faceIds.length; i++) {
      var f = faces[faceIds[i]];
      positions.push(f.a.x, f.a.y, f.a.z, f.b.x, f.b.y, f.b.z, f.c.x, f.c.y, f.c.z);
    }
    var geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    var mat = new THREE.MeshBasicMaterial({color: color, transparent: true, opacity: 0.7, side: THREE.DoubleSide,
      depthTest: false, polygonOffset: true, polygonOffsetFactor: -1});
    return new THREE.Mesh(geo, mat);
  }

  function clearHighlights() {
    for (var key in highlightMeshes) {
      if (highlightMeshes[key]) { scene.remove(highlightMeshes[key]); highlightMeshes[key] = null; }
    }
  }

  function clearSelection() {
    inputFaceIds = []; outputFaceIds = []; bufferFaceIds.clear();
    clearHighlights(); updateSimButton();
    updateStatus('Selection cleared');
  }

  function updateSimButton() {
    var btn = document.getElementById('btn-simulate');
    if (btn) btn.disabled = (inputFaceIds.length === 0 || outputFaceIds.length === 0);
  }

  function autoSelectFaces() {
    if (faces.length === 0) return;
    var result = RayTracer.autoDetectEndCaps(faces, faceNormals, faceCenters, faceAreas);
    inputFaceIds = result.input; outputFaceIds = result.output; bufferFaceIds.clear();
    updateHighlights();
    updateStatus('Auto: Input=' + inputFaceIds.length + ' faces, Output=' + outputFaceIds.length + ' faces');
  }

  function runSimulation() {
    if (inputFaceIds.length === 0 || outputFaceIds.length === 0) return;
    updateStatus('Simulating...');
    document.getElementById('mode-indicator').textContent = 'Simulating';
    document.getElementById('mode-indicator').className = 'mode-badge simulating';
    clearRaySegments();

    var n = parseFloat(document.getElementById('param-n').value);
    var alpha = parseFloat(document.getElementById('param-alpha').value);
    var angleSigma = parseFloat(document.getElementById('slider-angle').value);
    var posSigma = parseFloat(document.getElementById('slider-pos').value);
    var numRays = parseInt(document.getElementById('slider-rays').value);
    var maxBounces = parseInt(document.getElementById('slider-bounces').value);

    setTimeout(function() {
      var tracer = new RayTracer(mesh, {n: n, alpha: alpha, maxBounces: maxBounces,
        numRays: numRays, angleSigma: angleSigma, posSigma: posSigma,
        inputFaceIds: inputFaceIds, outputFaceIds: outputFaceIds});
      var results = tracer.simulate();
      visualizeRays(results.segments);
      var resultsCard = document.getElementById('results-card');
      var resultsContent = document.getElementById('results-content');
      resultsCard.style.display = 'block';
      resultsContent.innerHTML = '<div class="result-row"><span class="result-label">Total Rays</span><span class="result-value">' + results.total + '</span></div>'
        + '<div class="result-row"><span class="result-label">Success (Output)</span><span class="result-value" style="color:#22c55e">' + results.success + '</span></div>'
        + '<div class="result-row"><span class="result-label">Escaped</span><span class="result-value" style="color:#ef4444">' + results.escaped + '</span></div>'
        + '<div class="result-row"><span class="result-label">Exhausted</span><span class="result-value" style="color:#8892b0">' + results.exhausted + '</span></div>'
        + '<div class="result-row"><span class="result-label">Success Rate</span><span class="result-value" style="color:#22c55e">' + results.successRate + '%</span></div>';
      document.getElementById('mode-indicator').textContent = 'Done';
      document.getElementById('mode-indicator').className = 'mode-badge';
      updateStatus('Simulation complete: ' + results.successRate + '% success (' + results.success + '/' + results.total + ')');
    }, 50);
  }

  function visualizeRays(segments) {
    clearRaySegments();
    var cSuccess = new THREE.Color(0xdc143c);
    var cInBody = new THREE.Color(0x4b0082);
    var cEscape = new THREE.Color(0xff8c00);
    // Split into internal (depthTest=false) and escape (depthTest=true) segments
    var intPos = [], intCol = [];
    var escPos = [], escCol = [];
    for (var i = 0; i < segments.length; i++) {
      var seg = segments[i];
      if (seg.type === 'escape') {
        escPos.push(seg.start.x, seg.start.y, seg.start.z, seg.end.x, seg.end.y, seg.end.z);
        escCol.push(cEscape.r, cEscape.g, cEscape.b, cEscape.r, cEscape.g, cEscape.b);
      } else {
        var c = seg.type === 'success' ? cSuccess : cInBody;
        intPos.push(seg.start.x, seg.start.y, seg.start.z, seg.end.x, seg.end.y, seg.end.z);
        intCol.push(c.r, c.g, c.b, c.r, c.g, c.b);
      }
    }
    rayLines = new THREE.Group();
    // Internal rays: depthTest=false (visible through transparent model)
    if (intPos.length > 0) {
      var intGeo = new THREE.BufferGeometry();
      intGeo.setAttribute('position', new THREE.Float32BufferAttribute(intPos, 3));
      intGeo.setAttribute('color', new THREE.Float32BufferAttribute(intCol, 3));
      var intMat = new THREE.LineBasicMaterial({vertexColors: true, linewidth: 2, transparent: true, opacity: 0.9, depthTest: false});
      rayLines.add(new THREE.LineSegments(intGeo, intMat));
    }
    // Escape rays: depthTest=true (hidden by model surface, only visible outside)
    if (escPos.length > 0) {
      var escGeo = new THREE.BufferGeometry();
      escGeo.setAttribute('position', new THREE.Float32BufferAttribute(escPos, 3));
      escGeo.setAttribute('color', new THREE.Float32BufferAttribute(escCol, 3));
      var escMat = new THREE.LineBasicMaterial({vertexColors: true, linewidth: 2, transparent: true, opacity: 0.85, depthTest: true});
      rayLines.add(new THREE.LineSegments(escGeo, escMat));
    }
    scene.add(rayLines);
  }

  function clearRaySegments() {
    if (rayLines) {
      scene.remove(rayLines);
      rayLines.traverse(function(obj) {
        if (obj.geometry) obj.geometry.dispose();
        if (obj.material) obj.material.dispose();
      });
      rayLines = null;
    }
  }

  function resetView() {
    if (!meshGeometry) return;
    meshGeometry.computeBoundingBox();
    var bbox = meshGeometry.boundingBox;
    var center = new THREE.Vector3(); bbox.getCenter(center);
    var size = new THREE.Vector3(); bbox.getSize(size);
    var maxDim = Math.max(size.x, size.y, size.z) || 1;
    controls.target.copy(center);
    camera.position.set(center.x + maxDim * 1.5, center.y + maxDim, center.z + maxDim * 1.5);
    camera.near = maxDim * 0.01; camera.far = maxDim * 100;
    camera.updateProjectionMatrix();
    controls.update();
  }

  function updateStatus(msg) {
    var bar = document.getElementById('status-bar');
    if (bar) bar.textContent = msg;
  }

  // Boot
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
