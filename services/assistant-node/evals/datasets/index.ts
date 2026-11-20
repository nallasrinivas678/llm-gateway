import type { EvalDataset } from "../types.js";
import { handbook } from "./handbook.js";
import { lease } from "./lease.js";
import { pricing } from "./pricing.js";

export const datasets: EvalDataset[] = [lease, handbook, pricing];
