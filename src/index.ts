export default {
  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST") {
      return new Response("Use POST", { status: 405 });
    }

    const body = await request.json();

    const defect = body.defect; // "adhesion" | "pinhole"
    const context = body.context || {};

    let result;

    switch (defect) {
      case "adhesion":
        result = analyzeAdhesion(context);
        break;

      case "pinhole":
        result = analyzePinhole(context);
        break;

      default:
        result = {
          error: "Unknown defect type"
        };
    }

    return new Response(JSON.stringify(result, null, 2), {
      headers: { "Content-Type": "application/json" }
    });
  }
};

/* =========================
   TECHNOLOGICAL LOGIC
   ========================= */

function analyzeAdhesion(ctx: any) {
  const steps: string[] = [];

  steps.push("Проверка на режим на изсушаване");

  if (!ctx.drying || ctx.drying.temperature < ctx.targetTemperature) {
    steps.push("→ Увеличи температурата на изсушаване");
  }

  if (!ctx.drying || ctx.drying.time < ctx.targetTime) {
    steps.push("→ Увеличи времето (намали скоростта)");
  }

  steps.push("Проверка на количество лак");
  steps.push("→ Увеличи количеството лак при нужда");

  steps.push("Проверка на разредител");
  steps.push("→ Възможно е използван различен или неподходящ разредител");

  steps.push("Проверка на партида лак");
  steps.push("→ Тествай с друга партида лак");

  return {
    defect: "adhesion",
    priority: "drying → film build → solvent → batch",
    steps
  };
}

function analyzePinhole(ctx: any) {
  const steps: string[] = [];

  steps.push("Проверка на вискозитет на лака");

  if (!ctx.viscosity || ctx.viscosity > ctx.maxViscosity) {
    steps.push("→ Намали вискозитета (корекция с разредител)");
  }

  steps.push("Проверка за омасляване / замърсяване на повърхността");
  steps.push("→ Провери почистване, масла, силикони");

  return {
    defect: "pinhole",
    priority: "viscosity → surface contamination",
    steps
  };
}
