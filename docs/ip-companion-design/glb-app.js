import * as THREE from './vendor/three.module.js';
import { GLTFLoader } from './vendor/loaders/GLTFLoader.js';

const state = {
  mode: 'beginner',
  expression: 'happy',
  action: 'Idle',
};

const actionNames = {
  wave: 'Wave',
  cheer: 'Cheer',
  think: 'Think',
  sleep: 'Sleep',
  bounce: 'Jump',
};

function makeView(container, mini = false) {
  const scene = new THREE.Scene();
  scene.background = mini ? null : new THREE.Color(0xedf4fc);

  const camera = new THREE.PerspectiveCamera(mini ? 30 : 32, 1, 0.1, 100);
  camera.position.set(mini ? 0 : 1.0, mini ? 0.25 : 0.5, mini ? 10.8 : 10.2);
  camera.lookAt(mini ? 0 : 0.75, 0.25, 0);

  const renderer = new THREE.WebGLRenderer({
    antialias: true,
    alpha: mini,
    powerPreference: 'high-performance',
  });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 1.6));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.shadowMap.enabled = !mini;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  container.appendChild(renderer.domElement);

  scene.add(new THREE.HemisphereLight(0xf7fbff, 0x627692, 2.65));
  const key = new THREE.DirectionalLight(0xffffff, 3.4);
  key.position.set(4, 7, 6);
  key.castShadow = !mini;
  scene.add(key);
  const rim = new THREE.DirectionalLight(0x56aef2, 2.2);
  rim.position.set(-4, 3, -3);
  scene.add(rim);

  if (!mini) {
    const floor = new THREE.Mesh(
      new THREE.CircleGeometry(3.3, 64),
      new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.92 }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(0.95, -2.05, 0);
    floor.receiveShadow = true;
    scene.add(floor);
  }

  const root = new THREE.Group();
  root.position.x = mini ? 0 : 0.85;
  scene.add(root);

  return {
    scene,
    camera,
    renderer,
    root,
    container,
    mini,
    model: null,
    mixer: null,
    clips: [],
    activeAction: null,
    actionTimer: null,
    spin: 0,
    faceParts: [],
    width: 0,
    height: 0,
  };
}

const stage = document.querySelector('#stage');
const handle = document.querySelector('#petHandle');
const main = makeView(stage);
const mini = makeView(handle, true);
const views = [main, mini];
const status = document.querySelector('.status');

function prepareModel(model, view) {
  model.position.set(-0.56, -2.0, 0);
  model.scale.setScalar(view.mini ? 1.05 : 1.08);
  model.traverse((object) => {
    if (object.isMesh) {
      object.castShadow = !view.mini;
      object.receiveShadow = !view.mini;
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      materials.filter(Boolean).forEach((material) => {
        if (material.transparent) {
          material.depthWrite = false;
          material.side = THREE.DoubleSide;
        }
      });
    }
    if (/^(Eye_|Brow_)/.test(object.name)) {
      object.userData.baseScale = object.scale.clone();
      object.userData.baseRotation = object.rotation.clone();
      view.faceParts.push(object);
    }
  });
  view.model = model;
  view.root.add(model);
}

function clipFor(view, name) {
  return view.clips.find((clip) => clip.name === name);
}

function play(view, name, once = false) {
  if (!view.mixer) return;
  const clip = clipFor(view, name);
  if (!clip) return;
  clearTimeout(view.actionTimer);
  if (view.activeAction) view.activeAction.fadeOut(0.15);
  const action = view.mixer.clipAction(clip);
  action.reset();
  action.enabled = true;
  action.setEffectiveWeight(1);
  action.setEffectiveTimeScale(1);
  action.setLoop(once ? THREE.LoopOnce : THREE.LoopRepeat, once ? 1 : Infinity);
  action.clampWhenFinished = once;
  action.fadeIn(0.15).play();
  view.activeAction = action;
  if (once) {
    view.actionTimer = setTimeout(() => {
      if (state.action !== 'Sleep') play(view, 'Idle');
    }, Math.max(500, clip.duration * 1000));
  }
}

function playEverywhere(name, once = false) {
  state.action = name;
  views.forEach((view) => play(view, name, once));
}

function applyExpression(view, time) {
  if (!view.model) return;
  const blink = time % 4.2 > 4.02 ? Math.max(0.14, Math.abs(Math.sin((time % 4.2 - 4.02) / 0.18 * Math.PI))) : 1;
  view.faceParts.forEach((part) => {
    part.scale.copy(part.userData.baseScale);
    part.rotation.copy(part.userData.baseRotation);
    if (part.name.startsWith('Eye_')) {
      let eyeScale = blink;
      if (state.expression === 'happy') eyeScale *= 0.86;
      if (state.expression === 'focused') eyeScale *= 0.72;
      if (state.expression === 'surprise') part.scale.multiplyScalar(1.08);
      part.scale.y *= eyeScale;
    }
    if (part.name === 'Brow_L') {
      if (state.expression === 'curious') part.rotation.z += 0.15;
      if (state.expression === 'focused') part.rotation.z -= 0.18;
      if (state.expression === 'shy') part.rotation.z += 0.08;
    }
    if (part.name === 'Brow_R') {
      if (state.expression === 'curious') part.rotation.z -= 0.04;
      if (state.expression === 'focused') part.rotation.z += 0.18;
      if (state.expression === 'shy') part.rotation.z -= 0.08;
    }
  });
}

const loader = new GLTFLoader();
loader.load(
  './model/output/zx-fox.glb',
  (gltf) => {
    prepareModel(gltf.scene, main);
    prepareModel(gltf.scene.clone(true), mini);
    views.forEach((view) => {
      view.clips = gltf.animations;
      view.mixer = new THREE.AnimationMixer(view.model);
      play(view, 'Idle');
    });
    status.innerHTML = '<span class="dot"></span>专用 GLB 已加载 · 6 组动作';
  },
  undefined,
  (error) => {
    console.error('ZX Fox GLB failed to load', error);
    status.textContent = '专用 GLB 加载失败';
  },
);

function resize(view) {
  const rect = view.container.getBoundingClientRect();
  const width = Math.max(1, Math.round(rect.width));
  const height = Math.max(1, Math.round(rect.height));
  if (view.width === width && view.height === height) return;
  view.width = width;
  view.height = height;
  view.renderer.setSize(width, height, false);
  view.camera.aspect = width / height;
  view.camera.updateProjectionMatrix();
  if (!view.mini) view.root.position.y = width < 640 ? -0.42 : 0;
}

views.forEach(resize);
addEventListener('resize', () => views.forEach(resize));

const clock = new THREE.Clock();
function animate() {
  const delta = Math.min(0.04, clock.getDelta());
  const elapsed = clock.elapsedTime;
  views.forEach((view) => {
    if (view.mixer) view.mixer.update(delta);
    applyExpression(view, elapsed);
    if (view.spin > 0) {
      view.root.rotation.y += delta * 5.2;
      view.spin -= delta;
      if (view.spin <= 0) view.root.rotation.y = view.mini ? -0.18 : -0.12;
    } else if (view.mini) {
      view.root.rotation.y = -0.18 + Math.sin(elapsed * 0.55) * 0.10;
    }
    view.renderer.render(view.scene, view.camera);
  });
  requestAnimationFrame(animate);
}
requestAnimationFrame(animate);

function runAction(key) {
  document.querySelectorAll('[data-action]').forEach((button) => button.classList.toggle('active', button.dataset.action === key));
  if (key === 'spin') {
    views.forEach((view) => { view.spin = 1.25; });
    return;
  }
  const name = actionNames[key];
  if (name) playEverywhere(name, name !== 'Sleep');
}

document.querySelectorAll('[data-action]').forEach((button) => button.addEventListener('click', () => runAction(button.dataset.action)));
document.querySelectorAll('[data-expression]').forEach((button) => button.addEventListener('click', () => {
  state.expression = button.dataset.expression;
  document.querySelectorAll('[data-expression]').forEach((item) => item.classList.toggle('active', item === button));
}));

const workCopy = {
  beginner: '点击指定区域时展示由你配置的引导内容。',
  veteran: '不主动显示指引，只保留安静的陪伴动作。',
  qa: '可结合当前页面与被允许的平台统计回答，并提供跳转按钮。',
};

function chooseMode(mode) {
  state.mode = mode;
  document.querySelector('#modeQuote').textContent = workCopy[mode];
  document.querySelectorAll('[data-mode]').forEach((button) => button.classList.toggle('active', button.dataset.mode === mode));
}

const shell = document.querySelector('#petShell');
const dialog = document.querySelector('#petDialog');
const dialogTitle = document.querySelector('#dialogTitle');
const dialogText = document.querySelector('#dialogText');
const restore = document.querySelector('#restorePet');
const qaInput = document.querySelector('#qaInput');
const qaAnswer = document.querySelector('#qaAnswer');

function askMode() {
  shell.classList.remove('mini', 'hidden');
  restore.classList.remove('visible');
  dialog.classList.remove('qa');
  dialog.classList.add('asking');
  dialogTitle.textContent = '要切换哪种工作模式？';
  dialogText.textContent = 'ZX 小狐的 3D 形象保持不变。';
}

function showCurrentMode() {
  dialog.classList.remove('asking', 'qa');
  if (state.mode === 'beginner') {
    dialogTitle.textContent = '新手模式';
    dialogText.textContent = '这里展示之后由你配置的指引内容。';
  } else if (state.mode === 'veteran') {
    dialogTitle.textContent = '老手模式';
    dialogText.textContent = '我不会主动弹提示，只在旁边陪伴。';
  } else {
    dialog.classList.add('qa');
    dialogTitle.textContent = '问答模式';
    dialogText.textContent = '我会结合当前页面和允许的平台数据回答。';
  }
}

document.querySelectorAll('[data-mode]').forEach((button) => button.addEventListener('click', () => {
  chooseMode(button.dataset.mode);
  showCurrentMode();
}));
document.querySelectorAll('[data-pick]').forEach((button) => button.addEventListener('click', () => {
  chooseMode(button.dataset.pick);
  showCurrentMode();
}));

document.querySelector('#askButton').addEventListener('click', () => {
  const question = qaInput.value.trim();
  qaAnswer.textContent = !question
    ? '请先输入问题。'
    : question.includes('待确认')
      ? '演示回答：当前待确认客户数量较多，可点击下方“待确认客户”直接前往处理。'
      : question.includes('导入')
        ? '演示回答：在客户管理页面使用“批量导入”，上传 Excel 后先检查校验结果。'
        : '演示回答：我会读取当前路由、可公开的统计数字和系统操作说明，再给出答案与跳转入口。';
});
document.querySelectorAll('[data-jump]').forEach((button) => button.addEventListener('click', () => {
  qaAnswer.textContent = `原型演示：正式接入后将直接跳转到“${button.textContent}”对应页面或操作位置。`;
}));

let rotate = null;
let mainMoved = false;
main.renderer.domElement.addEventListener('pointerdown', (event) => {
  rotate = { x: event.clientX, rotation: main.root.rotation.y };
  mainMoved = false;
  main.renderer.domElement.setPointerCapture(event.pointerId);
});
main.renderer.domElement.addEventListener('pointermove', (event) => {
  if (!rotate) return;
  const distance = event.clientX - rotate.x;
  if (Math.abs(distance) > 4) mainMoved = true;
  main.root.rotation.y = rotate.rotation + distance * 0.012;
});
main.renderer.domElement.addEventListener('pointerup', () => {
  rotate = null;
  if (!mainMoved) askMode();
});

document.querySelector('#miniPet').addEventListener('click', () => {
  shell.classList.toggle('mini');
  requestAnimationFrame(() => resize(mini));
});
document.querySelector('#hidePet').addEventListener('click', () => {
  shell.classList.add('hidden');
  restore.classList.add('visible');
});
restore.addEventListener('click', askMode);

let drag = null;
let moved = false;
handle.addEventListener('pointerdown', (event) => {
  const rect = shell.getBoundingClientRect();
  drag = { dx: event.clientX - rect.left, dy: event.clientY - rect.top };
  moved = false;
  shell.classList.add('dragging');
  handle.setPointerCapture(event.pointerId);
  event.preventDefault();
});
handle.addEventListener('pointermove', (event) => {
  if (!drag) return;
  moved = true;
  const left = Math.max(8, Math.min(innerWidth - shell.offsetWidth - 8, event.clientX - drag.dx));
  const top = Math.max(8, Math.min(innerHeight - shell.offsetHeight - 8, event.clientY - drag.dy));
  shell.style.left = `${left}px`;
  shell.style.top = `${top}px`;
  shell.style.right = 'auto';
  shell.style.bottom = 'auto';
});
handle.addEventListener('pointerup', () => {
  if (!drag) return;
  drag = null;
  shell.classList.remove('dragging');
  if (!moved) {
    askMode();
    return;
  }
  const rect = shell.getBoundingClientRect();
  const left = rect.left + rect.width / 2 < innerWidth / 2 ? 8 : Math.max(8, innerWidth - rect.width - 8);
  shell.style.left = `${left}px`;
  shell.style.top = `${Math.max(8, Math.min(innerHeight - rect.height - 8, rect.top))}px`;
});

addEventListener('resize', () => {
  if (!shell.style.left) return;
  const rect = shell.getBoundingClientRect();
  shell.style.left = `${Math.max(8, Math.min(innerWidth - rect.width - 8, rect.left))}px`;
  shell.style.top = `${Math.max(8, Math.min(innerHeight - rect.height - 8, rect.top))}px`;
});

chooseMode('beginner');
