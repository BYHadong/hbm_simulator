// ==========================================
// 1. 시뮬레이션 환경 변수 (이곳에서 수정 가능)
// ==========================================
const CONFIG = {
  gridSize: 4, // 초기 격자 너비 (예: 4x4)
  numLayers: 4, // 초기 HBM 층수 (예: 4Hi)

  ambientTemp: 45.0, // 주변 기본 온도 (섭씨)
  targetTemp: 60.9, // 목표 최고 온도 (섭씨)

  // 열 발생 모델
  heatPerLayer: 10.0, // 층(Layer)당 발생하는 열 증가량

  // 쿨링(TSV) 모델
  baseCoolingPerTsv: 18.0, // TSV 1개당 기본 냉각 성능
  distancePenalty: 0.8, // 중앙에서 멀어질수록 냉각 성능이 떨어지는 비율
};

// ==========================================
// 2. 상태 관리 (State)
// ==========================================
let state = {
  gridSize: CONFIG.gridSize,
  numLayers: CONFIG.numLayers,
  placedTSVs: [], // {r: row, c: col} 배열
  currentTemp: 0,
  initialTemp: 0,
  isSuccess: false,
};

// ==========================================
// 3. DOM 요소 캐싱
// ==========================================
const gridEl = document.getElementById("grid");
const inputGridSize = document.getElementById("inputGridSize");
const inputNumLayers = document.getElementById("inputNumLayers");
const btnApply = document.getElementById("btnApply");
const currentTempDisplay = document.getElementById("currentTempDisplay");
const targetTempDisplay = document.getElementById("targetTempDisplay");
const tsvCountDisplay = document.getElementById("tsvCountDisplay");
const layerDisplay = document.getElementById("layerDisplay");
const messageArea = document.getElementById("messageArea");
const tempProgressBar = document.getElementById("tempProgressBar");

// ==========================================
// 4. 로직 함수
// ==========================================

function calculateTemperature() {
  // 1. 초기 온도 계산 (주변 온도 + (층수 * 층당 발열량))
  let maxTemp = CONFIG.ambientTemp + state.numLayers * CONFIG.heatPerLayer;
  state.initialTemp = maxTemp;

  // 중앙 좌표 (격자가 짝수면 소수점이 됨, 예: 4x4면 1.5)
  const centerR = (state.gridSize - 1) / 2;
  const centerC = (state.gridSize - 1) / 2;

  // 2. 설치된 TSV들에 의한 냉각 효과 적용
  // 적층 수가 많을수록 열이 더 갇히므로, TSV 하나의 효과가 층수에 비례하여 약간 감소하도록 설계
  const layerPenalty = Math.sqrt(state.numLayers / 4); // 4층 기준 1.0

  state.placedTSVs.forEach((tsv) => {
    // 중앙 발열원으로부터의 거리 계산 (피타고라스)
    const distance = Math.sqrt(
      Math.pow(tsv.r - centerR, 2) + Math.pow(tsv.c - centerC, 2),
    );

    // 거리가 멀수록 냉각 효과 감소
    const coolingEffect =
      CONFIG.baseCoolingPerTsv /
      layerPenalty /
      (1 + distance * CONFIG.distancePenalty);

    maxTemp -= coolingEffect;
  });

  // 주변 온도 이하로는 떨어지지 않음
  state.currentTemp = Math.max(CONFIG.ambientTemp, maxTemp);
}

function checkSuccess() {
  if (state.currentTemp <= CONFIG.targetTemp && !state.isSuccess) {
    state.isSuccess = true;
    messageArea.innerHTML = `<span class="success-msg">🎉 목표 온도(${CONFIG.targetTemp}℃) 달성! 완료되었습니다.</span>`;

    // 성공 시 남은 빈칸 클릭 방지 효과
    const emptyCells = document.querySelectorAll(".grid-cell:not(.has-tsv)");
    emptyCells.forEach((cell) => {
      cell.style.opacity = "0.5";
      cell.style.cursor = "not-allowed";
    });
  }
}

function handleCellClick(r, c, cellElement) {
  if (state.isSuccess) return; // 이미 성공했으면 클릭 무시

  // 이미 설치된 곳인지 확인
  const isAlreadyPlaced = state.placedTSVs.some(
    (tsv) => tsv.r === r && tsv.c === c,
  );
  if (isAlreadyPlaced) return;

  // TSV 설치
  state.placedTSVs.push({ r, c });

  // UI 업데이트
  cellElement.classList.add("has-tsv");

  updateGame();
}

// ==========================================
// 5. 렌더링 및 UI 업데이트
// ==========================================

function initGame() {
  // UI에서 설정값 읽어오기 (초기 로드 시에는 CONFIG 값 사용)
  state.gridSize = parseInt(inputGridSize.value) || CONFIG.gridSize;
  state.numLayers = parseInt(inputNumLayers.value) || CONFIG.numLayers;
  state.placedTSVs = [];
  state.isSuccess = false;
  messageArea.innerHTML = "";

  // 입력창 값 동기화
  inputGridSize.value = state.gridSize;
  inputNumLayers.value = state.numLayers;

  targetTempDisplay.innerText = CONFIG.targetTemp.toFixed(1);
  layerDisplay.innerText = `(${state.numLayers}Hi HBM)`;

  renderGrid();
  updateGame();
}

function renderGrid() {
  gridEl.innerHTML = "";

  // 그리드 CSS 동적 설정
  gridEl.style.gridTemplateColumns = `repeat(${state.gridSize}, 1fr)`;
  gridEl.style.gridTemplateRows = `repeat(${state.gridSize}, 1fr)`;

  // 셀 크기 계산 (그리드 크기에 따라 유동적)
  const maxGridPixels = 350;
  const gap = 8;
  const cellSize =
    (maxGridPixels - gap * (state.gridSize - 1)) / state.gridSize;

  const centerR = (state.gridSize - 1) / 2;
  const centerC = (state.gridSize - 1) / 2;

  for (let r = 0; r < state.gridSize; r++) {
    for (let c = 0; c < state.gridSize; c++) {
      const cell = document.createElement("div");
      cell.className = "grid-cell";
      cell.style.width = `${cellSize}px`;
      cell.style.height = `${cellSize}px`;

      // 중앙 쪽에 붉은색 시각적 힌트 부여 (발열원)
      const dist = Math.sqrt(
        Math.pow(r - centerR, 2) + Math.pow(c - centerC, 2),
      );
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

  // 온도 텍스트 업데이트
  currentTempDisplay.innerText = state.currentTemp.toFixed(1) + " °C";
  tsvCountDisplay.innerText = state.placedTSVs.length + "개";

  // 온도에 따른 색상 변경
  if (state.currentTemp <= CONFIG.targetTemp) {
    currentTempDisplay.className = "stat-value temp-safe";
    tempProgressBar.style.backgroundColor = "var(--heat-low)";
  } else {
    currentTempDisplay.className = "stat-value temp-high";
    tempProgressBar.style.backgroundColor = "var(--heat-high)";
  }

  // 프로그레스 바 너비 조정 (시작 온도 100%, 목표 온도 0% 기준 시각화)
  // 목표를 달성하면 게이지가 완전히 사라지는 형태
  const tempRange = state.initialTemp - CONFIG.targetTemp;
  const currentExcess = Math.max(0, state.currentTemp - CONFIG.targetTemp);
  let progressPercent = (currentExcess / tempRange) * 100;

  if (progressPercent < 0) progressPercent = 0;
  if (progressPercent > 100) progressPercent = 100;

  tempProgressBar.style.width = `${progressPercent}%`;
}

// ==========================================
// 6. 이벤트 리스너 및 초기화
// ==========================================
btnApply.addEventListener("click", initGame);

// 최초 실행
window.onload = initGame;
