export default {
  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST") {
      return new Response("Use POST", { status: 405 });
    }

    const body = await request.json();
    const defect = body.defect;

    let result;

    switch (defect) {
      case "adhesion":
        result = analyzeAdhesion(body);
        break;

      case "pinhole":
        result = analyzePinhole(body);
        break;

      default:
        result = {
          error: "Unknown defect type",
          supported: ["adhesion", "pinhole"],
        };
    }

    return new Response(JSON.stringify(result, null, 2), {
      headers: { "Content-Type": "application/json" },
    });
  },
};

/* =========================
   ADHESION ANALYSIS LOGIC
   ========================= */

function analyzeAdhesion(data: any) {
  const steps: string[] = [];

  // 1. Drying regime
  steps.push(
    "Check drying regime: temperature and time (line speed). " +
    "Increase temperature and/or increase drying time if below target."
  );

  // 2. Coating amount
  steps.push(
    "Check coating amount. If film is too thin, increase lacquer quantity."
  );

  // 3. Solvent check
  steps.push(
    "Verify solvent type and ratio. Check for unapproved or different thinner."
  );

  // 4. Lacquer batch
  steps.push(
    "If issue persists, suspect lacquer batch. Test with another batch."
  );

  return {
    defect: "adhesion",
    priority: "process first, material second",
    recommended_steps: steps,
  };
}

/* =========================
   PINHOLE ANALYSIS LOGIC
   ========================= */

function analyzePinhole(data: any) {
  const steps: string[] = [];

  // 1. Viscosity
  steps.push(
    "Check lacquer viscosity first. Adjust to target viscosity range."
  );

  // 2. Surface contamination
  steps.push(
    "Check for surface contamination or oiling of substrate."
  );

  return {
    defect: "pinhole",
    priority: "viscosity first",
    recommended_steps: steps,
  };
}
