// ==========================================
// 1. 시뮬레이션 환경 변수 (이곳에서 수정 가능)
// ==========================================
const CONFIG = {
  gridSize: 5, // 초기 격자 너비 (예: 5x5)
  numLayers: 4, // 초기 HBM 층수 (예: 4Hi)

  ambientTemp: 45.0, // 주변 기본 온도 (섭씨)
  targetTemp: 60.9, // 목표 최고 온도 (섭씨)

  // 열 발생 모델 (파이썬 설정 반영: P_logic=2.0W, P_core_layer=2.0W)
  heatLogicDie: 10.0, // 로직 다이(베이스) 고정 발열에 의한 온도 증가량
  heatPerCoreLayer: 10.0, // 코어 다이 층(Layer)당 발생하는 열 증가량

  // 쿨링(TSV) 모델
  baseCoolingPerTsv: 0.12, // TSV 1개당 초과 온도(발열) 감소 비율 (12% 감소)
  distancePenalty: 0.6, // 중앙에서 멀어질수록 냉각 성능이 떨어지는 비율
};

// ==========================================
// 2. 상태 관리 (State)
// ==========================================
let state = {
  gridSize: CONFIG.gridSize,
  numLayers: CONFIG.numLayers,
  placedTSVs: [], // {r: row, c: col} 배열
  gridTemp: [],   // 2D 온도 격자
  currentTemp: 0,
  initialTemp: 0,
  isSuccess: false,
};
let autoSolveInterval = null;
let currentSpeed = 600;

let tempChart = null;
let chartLabels = [];
let chartData = [];
let chartStep = 0;

// ==========================================
// 3. DOM 요소 캐싱
// ==========================================
const gridEl = document.getElementById("grid");
const inputGridSize = document.getElementById("inputGridSize");
const inputNumLayers = document.getElementById("inputNumLayers");
const btnApply = document.getElementById("btnApply");
const btnAutoSolve = document.getElementById("btnAutoSolve");
const btnInstantSolve = document.getElementById("btnInstantSolve");
const inputSpeed = document.getElementById("inputSpeed");
const currentTempDisplay = document.getElementById("currentTempDisplay");
const targetTempDisplay = document.getElementById("targetTempDisplay");
const tsvCountDisplay = document.getElementById("tsvCountDisplay");
const estTsvDisplay = document.getElementById("estTsvDisplay");
const layerDisplay = document.getElementById("layerDisplay");
const messageArea = document.getElementById("messageArea");
const tempProgressBar = document.getElementById("tempProgressBar");
const consoleLog = document.getElementById("consoleLog");

// ==========================================
// 4. 로직 함수
// ==========================================

function calculateTemperature() {
  // 2D 온도 배열 초기화 및 격자 크기 변경 대응
  if (!state.gridTemp || state.gridTemp.length !== state.gridSize) {
    state.gridTemp = Array(state.gridSize).fill(0).map(() => Array(state.gridSize).fill(0));
  }

  const centerR = (state.gridSize - 1) / 2;
  const centerC = (state.gridSize - 1) / 2;
  
  // 최고 초기 온도 (중앙 기준)
  const maxInitialTemp = CONFIG.ambientTemp + CONFIG.heatLogicDie + (state.numLayers * CONFIG.heatPerCoreLayer);
  state.initialTemp = maxInitialTemp;

  // 1. 초기 2D 온도 맵 생성 (중앙 핫스팟으로부터 멀어질수록 감쇠하는 형태)
  for (let r = 0; r < state.gridSize; r++) {
    for (let c = 0; c < state.gridSize; c++) {
      const distance = Math.sqrt(Math.pow(r - centerR, 2) + Math.pow(c - centerC, 2));
      // 중앙에서 멀어질수록 발열 영향 감소
      const cellHeat = (CONFIG.heatLogicDie + state.numLayers * CONFIG.heatPerCoreLayer) * Math.exp(-0.35 * distance);
      state.gridTemp[r][c] = CONFIG.ambientTemp + cellHeat;
    }
  }

  // 2. 각 TSV에 의한 공간적 냉각 효과 적용 (로그형 점근 곡선을 위한 곱셈 감쇠 모델)
  // 파이썬의 물리 모델처럼 델타 T(초과 온도)에 비례해서 열이 빠져나가도록 수정
  const layerPenalty = Math.sqrt(state.numLayers / 4); // 4층 기준 패널티 1.0

  state.placedTSVs.forEach((tsv) => {
    for (let r = 0; r < state.gridSize; r++) {
      for (let c = 0; c < state.gridSize; c++) {
        const distToTsv = Math.sqrt(Math.pow(r - tsv.r, 2) + Math.pow(c - tsv.c, 2));
        
        // TSV가 차감하는 초과 온도의 비율 (예: 0.12)
        const coolingFactor = (CONFIG.baseCoolingPerTsv / layerPenalty) / (1 + distToTsv * CONFIG.distancePenalty);
        
        // 현재 셀의 주변 온도 대비 '초과 발열 온도'
        const excess = state.gridTemp[r][c] - CONFIG.ambientTemp;
        
        // 초과 온도에 (1 - coolingFactor)를 곱하여 감쇠
        const multiplier = Math.max(0, 1 - coolingFactor);
        state.gridTemp[r][c] = CONFIG.ambientTemp + (excess * multiplier);
      }
    }
  });

  // 3. 현재 칩 전체에서의 최고 온도(Tmax)를 대표 온도로 설정
  let maxT = -999;
  for (let r = 0; r < state.gridSize; r++) {
    for (let c = 0; c < state.gridSize; c++) {
      if (state.gridTemp[r][c] > maxT) {
        maxT = state.gridTemp[r][c];
      }
    }
  }
  state.currentTemp = maxT;
}

function handleCellClick(r, c, cellElement) {
  // 만약 자동 최적화 진행 중이면 중지
  if (autoSolveInterval) {
    stopAutoSolve();
    addLog("사용자 개입으로 자동 최적화를 일시중지합니다.", "warn");
  }

  const existingIndex = state.placedTSVs.findIndex(
    (tsv) => tsv.r === r && tsv.c === c,
  );

  if (existingIndex !== -1) {
    state.placedTSVs.splice(existingIndex, 1);
    cellElement.classList.remove("has-tsv");
    addLog(`TSV 제거: (${r + 1}, ${c + 1})`, "info");
  } else {
    state.placedTSVs.push({ r, c });
    cellElement.classList.add("has-tsv");
    addLog(`TSV 배치: (${r + 1}, ${c + 1})`, "info");
  }

  updateGame();
  addChartPoint(state.currentTemp);
}

// ==========================================
// 5. 렌더링 및 UI 업데이트
// ==========================================

function initGame() {
  stopAutoSolve();
  
  // UI에서 설정값 읽어오기
  state.gridSize = parseInt(inputGridSize.value) || CONFIG.gridSize;
  state.numLayers = parseInt(inputNumLayers.value) || CONFIG.numLayers;
  state.placedTSVs = [];
  state.isSuccess = false;
  messageArea.innerHTML = "";
  
  clearLog();
  addLog("시뮬레이터 초기화 완료.", "success");
  addLog(`격자 크기: ${state.gridSize}x${state.gridSize}, 적층 수: ${state.numLayers}Hi HBM`, "info");

  // 입력창 값 동기화
  inputGridSize.value = state.gridSize;
  inputNumLayers.value = state.numLayers;

  targetTempDisplay.innerText = CONFIG.targetTemp.toFixed(1);
  layerDisplay.innerText = `(${state.numLayers}Hi HBM)`;

  renderGrid();
  updateGame();
  resetChart(state.currentTemp);
}

function renderGrid() {
  gridEl.innerHTML = "";

  gridEl.style.gridTemplateColumns = `repeat(${state.gridSize}, 1fr)`;
  gridEl.style.gridTemplateRows = `repeat(${state.gridSize}, 1fr)`;

  const maxGridPixels = 350;
  const gap = 8;
  let cellSize = (maxGridPixels - gap * (state.gridSize - 1)) / state.gridSize;
  cellSize = Math.max(24, Math.floor(cellSize)); // 최소 24x24 픽셀 보장 및 정수 단위 맞춤

  const centerR = (state.gridSize - 1) / 2;
  const centerC = (state.gridSize - 1) / 2;

  for (let r = 0; r < state.gridSize; r++) {
    for (let c = 0; c < state.gridSize; c++) {
      const cell = document.createElement("div");
      cell.className = "grid-cell";
      cell.style.width = `${cellSize}px`;
      cell.style.height = `${cellSize}px`;
      
      // Auto-Solve에서 검색할 수 있도록 좌표 속성 부여
      cell.setAttribute("data-r", r);
      cell.setAttribute("data-c", c);

      // 발열원 힌트 (중앙 구역)
      const dist = Math.sqrt(Math.pow(r - centerR, 2) + Math.pow(c - centerC, 2));
      if (dist <= 1.5) {
        cell.classList.add("center-hint");
      }

      cell.addEventListener("click", () => handleCellClick(r, c, cell));
      gridEl.appendChild(cell);
    }
  }
}

function updateGame() {
  calculateTemperature();

  // 핫스팟 (가장 뜨거운 셀) 좌표 탐색
  let maxT = -999;
  let hotR = -1;
  let hotC = -1;
  for (let r = 0; r < state.gridSize; r++) {
    for (let c = 0; c < state.gridSize; c++) {
      if (state.gridTemp[r][c] > maxT) {
        maxT = state.gridTemp[r][c];
        hotR = r;
        hotC = c;
      }
    }
  }

  // 2D 히트맵 시각화 및 핫스팟 하이라이트 적용
  const cells = document.querySelectorAll(".grid-cell");
  cells.forEach((cell) => {
    const r = parseInt(cell.getAttribute("data-r"));
    const c = parseInt(cell.getAttribute("data-c"));
    const temp = state.gridTemp[r][c];

    // 마우스 호버 시 툴팁으로 개별 온도 안내
    cell.title = `위치: (${r + 1}, ${c + 1}) | 온도: ${temp.toFixed(1)}°C`;

    // 핫스팟 셀에 Glow 테두리 애니메이션 적용
    if (r === hotR && c === hotC) {
      cell.classList.add("is-hotspot");
    } else {
      cell.classList.remove("is-hotspot");
    }

    const hasTsv = state.placedTSVs.some((t) => t.r === r && t.c === c);
    if (!hasTsv) {
      // 파란색(220)에서 빨간색(0) 사이의 온도를 HSL로 비례 색상 변환
      const minTemp = CONFIG.ambientTemp;
      const maxTemp = state.initialTemp;
      const range = Math.max(1, maxTemp - minTemp);
      const ratio = Math.max(0, Math.min(1, (temp - minTemp) / range));
      const hue = 220 - ratio * 220; 
      cell.style.backgroundColor = `hsl(${hue}, 85%, 65%)`;
    } else {
      // TSV가 설치된 셀은 CSS (.has-tsv) 구리 스타일이 적용되도록 배경색 제거
      cell.style.backgroundColor = "";
    }
  });

  // 대시보드 텍스트 업데이트
  currentTempDisplay.innerText = state.currentTemp.toFixed(1) + " °C";
  tsvCountDisplay.innerText = state.placedTSVs.length + "개";

  // 예상 물리 TSV 핀 수 계산 (40um 피치 기준 면적 비례 수치 적용)
  const Lx = 11e-3;
  const tsvPitch = 40e-6;
  const radius = 0.36 * (Lx / state.gridSize);
  const clusterArea = Math.PI * Math.pow(radius, 2);
  const tsvsPerCluster = Math.floor(clusterArea / Math.pow(tsvPitch, 2));
  const totalEstTsvs = state.placedTSVs.length * tsvsPerCluster;
  estTsvDisplay.innerText = totalEstTsvs.toLocaleString() + " 개";

  // 온도에 따른 텍스트 색상 및 프로그레스 바 배경 변경
  if (state.currentTemp <= CONFIG.targetTemp) {
    currentTempDisplay.className = "stat-value temp-safe";
    tempProgressBar.style.backgroundColor = "var(--heat-low)";
    
    if (!state.isSuccess) {
      state.isSuccess = true;
      messageArea.innerHTML = `<span class="success-msg">🎉 목표 온도(${CONFIG.targetTemp}℃) 달성! 완료되었습니다.</span>`;
      addLog(`목표 온도 만족 달성! (최고 온도: ${state.currentTemp.toFixed(1)}°C, TSV 클러스터: ${state.placedTSVs.length}개)`, "success");
    }
  } else {
    currentTempDisplay.className = "stat-value temp-high";
    tempProgressBar.style.backgroundColor = "var(--heat-high)";
    
    if (state.isSuccess) {
      state.isSuccess = false;
      messageArea.innerHTML = "";
    }
  }

  // 프로그레스 바 업데이트
  const tempRange = state.initialTemp - CONFIG.targetTemp;
  const currentExcess = Math.max(0, state.currentTemp - CONFIG.targetTemp);
  let progressPercent = (currentExcess / tempRange) * 100;

  if (progressPercent < 0) progressPercent = 0;
  if (progressPercent > 100) progressPercent = 100;

  tempProgressBar.style.width = `${progressPercent}%`;
}

// ==========================================
// 6. 자동 최적화 (Greedy Algorithm) 및 로그 유틸리티
// ==========================================

function addLog(message, type = "info") {
  if (!consoleLog) return;
  const line = document.createElement("div");
  line.className = `log-line ${type}`;
  line.innerText = `[${new Date().toLocaleTimeString()}] ${message}`;
  consoleLog.appendChild(line);
  consoleLog.scrollTop = consoleLog.scrollHeight;
}

function clearLog() {
  if (consoleLog) {
    consoleLog.innerHTML = "";
  }
}

// 차트 관련 함수
function initChart() {
  const ctx = document.getElementById("tempChart").getContext("2d");
  tempChart = new Chart(ctx, {
    type: "line",
    data: {
      labels: [],
      datasets: [
        {
          label: "최고 온도 (Tmax)",
          data: [],
          borderColor: "rgba(220, 53, 69, 1)",
          backgroundColor: "rgba(220, 53, 69, 0.2)",
          tension: 0.1,
          pointStyle: "circle",
          pointRadius: 4,
          pointHoverRadius: 6,
        },
        {
          label: "목표 온도 (Target)",
          data: [],
          borderColor: "rgba(25, 135, 84, 1)",
          borderDash: [5, 5],
          pointRadius: 0,
          fill: false,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        x: {
          title: { display: true, text: "Optimization step" },
        },
        y: {
          title: { display: true, text: "Maximum temperature [degC]" },
        },
      },
    },
  });
}

function resetChart(initialTemp) {
  if (!tempChart) initChart();
  chartStep = 0;
  chartLabels = [0];
  chartData = [initialTemp];
  tempChart.data.labels = chartLabels;
  tempChart.data.datasets[0].data = chartData;
  tempChart.data.datasets[1].data = [CONFIG.targetTemp];
  tempChart.update();
}

function addChartPoint(tmax) {
  chartStep++;
  chartLabels.push(chartStep);
  chartData.push(tmax);
  if (tempChart) {
    tempChart.data.labels = chartLabels;
    tempChart.data.datasets[0].data = chartData;
    tempChart.data.datasets[1].data = chartLabels.map(() => CONFIG.targetTemp);
    tempChart.update();
  }
}

// 핫스팟 탐색 및 그리디 탐색 시뮬레이션
function findBestTsvCandidate() {
  let maxT = -999;
  let hotR = -1;
  let hotC = -1;
  for (let r = 0; r < state.gridSize; r++) {
    for (let c = 0; c < state.gridSize; c++) {
      if (state.gridTemp[r][c] > maxT) {
        maxT = state.gridTemp[r][c];
        hotR = r;
        hotC = c;
      }
    }
  }

  let candidates = [];
  for (let r = 0; r < state.gridSize; r++) {
    for (let c = 0; c < state.gridSize; c++) {
      const hasTsv = state.placedTSVs.some((t) => t.r === r && t.c === c);
      if (!hasTsv) {
        const dist = Math.sqrt(Math.pow(r - hotR, 2) + Math.pow(c - hotC, 2));
        candidates.push({ r, c, dist });
      }
    }
  }

  if (candidates.length === 0) return null;

  // 핫스팟 근처 후보 선정 (오름차순 정렬 후 상위 6개 테스트)
  candidates.sort((a, b) => a.dist - b.dist);
  const topK = candidates.slice(0, 6);

  let bestCand = null;
  let minTmax = Infinity;

  topK.forEach((cand) => {
    state.placedTSVs.push({ r: cand.r, c: cand.c });
    calculateTemperature();
    const tMax = state.currentTemp;
    if (tMax < minTmax) {
      minTmax = tMax;
      bestCand = cand;
    }
    state.placedTSVs.pop();
  });

  calculateTemperature(); // 원래 상태 복구
  return bestCand;
}

function toggleAutoSolve() {
  if (autoSolveInterval) {
    stopAutoSolve();
    addLog("자동 최적화를 일시 중지했습니다.", "warn");
  } else {
    startAutoSolve();
  }
}

function startAutoSolve() {
  if (state.isSuccess) {
    addLog("이미 목표 온도 요구사항을 달성했습니다.", "warn");
    return;
  }

  btnAutoSolve.innerText = "중지 (Stop)";
  btnAutoSolve.style.backgroundColor = "var(--heat-high)";
  addLog("그리디 탐색 자동 최적화를 시작합니다...", "info");

  autoSolveInterval = setInterval(() => {
    const best = findBestTsvCandidate();
    if (!best) {
      stopAutoSolve();
      addLog("더 이상 배치할 빈 공간이 없습니다.", "warn");
      return;
    }

    state.placedTSVs.push({ r: best.r, c: best.c });
    
    // UI 동적 반영
    const cellEl = document.querySelector(`.grid-cell[data-r="${best.r}"][data-c="${best.c}"]`);
    if (cellEl) {
      cellEl.classList.add("has-tsv");
    }

    updateGame();
    addChartPoint(state.currentTemp);
    addLog(`Step ${state.placedTSVs.length}: TSV 배치 (${best.r + 1}, ${best.c + 1}) -> 최고 온도: ${state.currentTemp.toFixed(1)}°C`, "info");

    if (state.isSuccess) {
      stopAutoSolve();
    }
  }, currentSpeed);
}

function stopAutoSolve() {
  if (autoSolveInterval) {
    clearInterval(autoSolveInterval);
    autoSolveInterval = null;
  }
  btnAutoSolve.innerText = "자동 최적화 (Auto)";
  btnAutoSolve.style.backgroundColor = ""; // Reset to default .btn-secondary class color
}

function instantSolve() {
  if (state.isSuccess) {
    addLog("이미 목표 온도를 달성했습니다.", "warn");
    return;
  }

  stopAutoSolve();
  addLog("즉시 완료 모드를 실행합니다...", "info");

  let maxIterations = 50; // 무한 루프 방지
  while (!state.isSuccess && maxIterations > 0) {
    const best = findBestTsvCandidate();
    if (!best) {
      addLog("더 이상 배치할 빈 공간이 없습니다.", "warn");
      break;
    }

    state.placedTSVs.push({ r: best.r, c: best.c });
    updateGame();
    addChartPoint(state.currentTemp);
    
    // UI 동적 반영
    const cellEl = document.querySelector(`.grid-cell[data-r="${best.r}"][data-c="${best.c}"]`);
    if (cellEl) {
      cellEl.classList.add("has-tsv");
    }
    
    addLog(`Step ${state.placedTSVs.length}: TSV 배치 (${best.r + 1}, ${best.c + 1}) -> 최고 온도: ${state.currentTemp.toFixed(1)}°C`, "info");
    maxIterations--;
  }
  addLog("즉시 완료 동작 종료.", "success");
}

// ==========================================
// 7. 이벤트 리스너 및 초기화
// ==========================================
btnApply.addEventListener("click", initGame);
btnAutoSolve.addEventListener("click", toggleAutoSolve);
btnInstantSolve.addEventListener("click", instantSolve);

inputSpeed.addEventListener("change", (e) => {
  currentSpeed = parseInt(e.target.value);
  if (autoSolveInterval) {
    // 재시작하여 새로운 속도 적용
    clearInterval(autoSolveInterval);
    autoSolveInterval = setInterval(() => {
      // Logic duplicated for the interval
      const best = findBestTsvCandidate();
      if (!best) {
        stopAutoSolve();
        addLog("더 이상 배치할 빈 공간이 없습니다.", "warn");
        return;
      }
      state.placedTSVs.push({ r: best.r, c: best.c });
      const cellEl = document.querySelector(`.grid-cell[data-r="${best.r}"][data-c="${best.c}"]`);
      if (cellEl) cellEl.classList.add("has-tsv");
      updateGame();
      addChartPoint(state.currentTemp);
      addLog(`Step ${state.placedTSVs.length}: TSV 배치 (${best.r + 1}, ${best.c + 1}) -> 최고 온도: ${state.currentTemp.toFixed(1)}°C`, "info");
      if (state.isSuccess) stopAutoSolve();
    }, currentSpeed);
  }
});

// Resizer Logic
const resizer = document.getElementById("resizer");
const sidebar = document.getElementById("sidebar");

let isResizing = false;

resizer.addEventListener("mousedown", (e) => {
  isResizing = true;
  document.body.style.cursor = "col-resize";
});

window.addEventListener("mousemove", (e) => {
  if (!isResizing) return;
  // Limit resizing bounds
  let newWidth = e.clientX;
  if (newWidth < 400) newWidth = 400;
  if (newWidth > window.innerWidth * 0.8) newWidth = window.innerWidth * 0.8;
  sidebar.style.width = `${newWidth}px`;
});

window.addEventListener("mouseup", () => {
  if (isResizing) {
    isResizing = false;
    document.body.style.cursor = "default";
  }
});

// 최초 실행
window.onload = initGame;
