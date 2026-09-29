import "dotenv/config";
import { updateGeoCity } from "../src/lib/updateGeoCity.js";
if (!await updateGeoCity()) process.exitCode = 1;
