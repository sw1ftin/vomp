import * as path from "node:path";
import { APP_NAME } from "@oh-my-pi/pi-utils/dirs";

export const CLI_BIN_NAME =
	process.env.OMP_CLI_NAME === "vomp" || /^vomp(?:\.exe)?$/i.test(path.basename(process.execPath)) ? "vomp" : APP_NAME;
