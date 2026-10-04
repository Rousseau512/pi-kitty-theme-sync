import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
} from "@earendil-works/pi-coding-agent";

interface ColorOverrides {
	background?: string;
	foreground?: string;
	palette: Record<number, string>;
}

export interface KittyColors {
	background: string;
	foreground: string;
	palette: Record<number, string>;
}

interface KittyColorSource {
	colors: KittyColors;
	label: string;
}

const FALLBACK_PALETTE: Record<number, string> = {
	0: "#000000",
	1: "#cc6666",
	2: "#98c379",
	3: "#e5c07b",
	4: "#61afef",
	5: "#c678dd",
	6: "#56b6c2",
	7: "#d4d4d4",
	8: "#666666",
	9: "#cc6666",
	10: "#98c379",
	11: "#e5c07b",
	12: "#61afef",
	13: "#c678dd",
	14: "#56b6c2",
	15: "#ffffff",
};

const NAMED_COLORS: Record<string, string> = {
	black: "#000000",
	red: "#ff0000",
	green: "#00ff00",
	yellow: "#ffff00",
	blue: "#0000ff",
	magenta: "#ff00ff",
	cyan: "#00ffff",
	white: "#ffffff",
	gray: "#808080",
	grey: "#808080",
};

function createColorOverrides(): ColorOverrides {
	return { palette: {} };
}

function hasColorData(colors: ColorOverrides): boolean {
	return Boolean(colors.background || colors.foreground || Object.keys(colors.palette).length > 0);
}

function withDefaults(colors: ColorOverrides): KittyColors {
	return {
		background: colors.background ?? "#1e1e1e",
		foreground: colors.foreground ?? "#d4d4d4",
		palette: { ...FALLBACK_PALETTE, ...colors.palette },
	};
}

function expandHome(path: string): string {
	if (path === "~") return homedir();
	if (path.startsWith("~/")) return join(homedir(), path.slice(2));
	return path;
}

function normalizeColor(value: string): string | null {
	const token = value.trim().split(/\s+/)[0];
	if (!token) return null;

	if (/^#[0-9a-fA-F]{3}$/.test(token)) {
		return `#${token[1]}${token[1]}${token[2]}${token[2]}${token[3]}${token[3]}`;
	}
	if (/^#[0-9a-fA-F]{6}$/.test(token)) return token;
	if (/^[0-9a-fA-F]{6}$/.test(token)) return `#${token}`;
	return NAMED_COLORS[token.toLowerCase()] ?? null;
}

function parseColorLines(output: string): ColorOverrides {
	const colors = createColorOverrides();

	for (const rawLine of output.split("\n")) {
		const line = rawLine.trim();
		if (!line || line.startsWith("#")) continue;

		const match = line.match(/^(\S+)\s+(.+)$/);
		if (!match) continue;
		const [, key, rawValue] = match;
		if (!key || !rawValue) continue;

		const color = normalizeColor(rawValue);
		if (!color) continue;
		if (key === "background") {
			colors.background = color;
		} else if (key === "foreground") {
			colors.foreground = color;
		} else {
			const paletteMatch = key.match(/^color(\d+)$/);
			if (!paletteMatch) continue;
			const index = Number.parseInt(paletteMatch[1] ?? "", 10);
			if (index >= 0 && index <= 15) colors.palette[index] = color;
		}
	}

	return colors;
}

/** Parse output from `kitten @ get-colors`. */
export function parseKittyColors(output: string): KittyColors | null {
	const overrides = parseColorLines(output);
	return hasColorData(overrides) ? withDefaults(overrides) : null;
}

function resolveIncludePath(rawPath: string, includingFile: string): string {
	const path = expandHome(rawPath.trim().replace(/^("|')(.*)\1$/, "$2"));
	return isAbsolute(path) ? path : resolve(dirname(includingFile), path);
}

function parseKittyConfigFile(
	filePath: string,
	colors: ColorOverrides,
	visited: Set<string>,
): void {
	const resolvedPath = resolve(filePath);
	if (visited.has(resolvedPath) || visited.size >= 64) return;
	visited.add(resolvedPath);

	let content: string;
	try {
		content = readFileSync(resolvedPath, "utf8");
	} catch {
		return;
	}

	for (const rawLine of content.split("\n")) {
		const line = rawLine.trim();
		if (!line || line.startsWith("#")) continue;

		const match = line.match(/^(\S+)\s+(.+)$/);
		if (!match) continue;
		const [, key, rawValue] = match;
		if (!key || !rawValue) continue;

		if (key === "include") {
			parseKittyConfigFile(resolveIncludePath(rawValue, resolvedPath), colors, visited);
			continue;
		}

		const color = normalizeColor(rawValue);
		if (!color) continue;
		if (key === "background") {
			colors.background = color;
		} else if (key === "foreground") {
			colors.foreground = color;
		} else {
			const paletteMatch = key.match(/^color(\d+)$/);
			if (!paletteMatch) continue;
			const index = Number.parseInt(paletteMatch[1] ?? "", 10);
			if (index >= 0 && index <= 15) colors.palette[index] = color;
		}
	}
}

/** Parse a kitty.conf file and its relative include files. */
export function parseKittyConfig(configPath: string): KittyColors | null {
	const overrides = createColorOverrides();
	parseKittyConfigFile(configPath, overrides, new Set());
	return hasColorData(overrides) ? withDefaults(overrides) : null;
}

function getKittyConfigDirectory(): string {
	const configuredDirectory = process.env.KITTY_CONFIG_DIRECTORY?.trim();
	if (configuredDirectory) return expandHome(configuredDirectory);

	const xdgConfigHome = process.env.XDG_CONFIG_HOME?.trim();
	const configHome = xdgConfigHome ? expandHome(xdgConfigHome) : join(homedir(), ".config");
	return join(configHome, "kitty");
}

function readConfiguredKittyColors(): KittyColors | null {
	const configDirectory = getKittyConfigDirectory();
	const candidates = [
		join(configDirectory, "kitty.conf"),
		join(configDirectory, "current-theme.conf"),
	];

	for (const candidate of candidates) {
		if (!existsSync(candidate)) continue;
		const colors = parseKittyConfig(candidate);
		if (colors) return colors;
	}
	return null;
}

async function readRemoteKittyColors(
	pi: ExtensionAPI,
	configured: boolean,
): Promise<KittyColors | null> {
	const windowId = process.env.KITTY_WINDOW_ID?.trim();
	// Outside a Kitty window and without Kitty's socket (a multiplexer pane started
	// elsewhere, a plain SSH session) nothing answers `kitten @`, so every attempt
	// would only end at its timeout.
	if (!windowId && !process.env.KITTY_LISTEN_ON?.trim()) return null;

	const args = ["@", "get-colors"];
	if (configured) args.push("--configured");
	if (windowId) args.push("--match", `id:${windowId}`);

	for (const executable of ["kitten", "kitty"]) {
		try {
			const result = await pi.exec(executable, args, { timeout: 5000 });
			if (result.code !== 0 || !result.stdout.trim()) continue;
			const colors = parseKittyColors(result.stdout);
			if (colors) return colors;
		} catch {
			// Try the next Kitty executable or the config-file fallback.
		}
	}
	return null;
}

async function readKittyColors(
	pi: ExtensionAPI,
	configured: boolean,
): Promise<KittyColorSource | null> {
	const remoteColors = await readRemoteKittyColors(pi, configured);
	if (remoteColors) {
		return { colors: remoteColors, label: "Kitty remote control" };
	}

	const configColors = readConfiguredKittyColors();
	return configColors ? { colors: configColors, label: "Kitty config fallback" } : null;
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
	const value = hex.replace("#", "");
	return {
		r: Number.parseInt(value.substring(0, 2), 16),
		g: Number.parseInt(value.substring(2, 4), 16),
		b: Number.parseInt(value.substring(4, 6), 16),
	};
}

function rgbToHex(r: number, g: number, b: number): string {
	const clamp = (value: number) => Math.round(Math.min(255, Math.max(0, value)));
	return `#${clamp(r).toString(16).padStart(2, "0")}${clamp(g).toString(16).padStart(2, "0")}${clamp(b).toString(16).padStart(2, "0")}`;
}

function getLuminance(hex: string): number {
	const { r, g, b } = hexToRgb(hex);
	return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}

function adjustBrightness(hex: string, amount: number): string {
	const { r, g, b } = hexToRgb(hex);
	return rgbToHex(r + amount, g + amount, b + amount);
}

function mixColors(color1: string, color2: string, weight: number): string {
	const first = hexToRgb(color1);
	const second = hexToRgb(color2);
	return rgbToHex(
		first.r * weight + second.r * (1 - weight),
		first.g * weight + second.g * (1 - weight),
		first.b * weight + second.b * (1 - weight),
	);
}

export function generatePiTheme(colors: KittyColors, themeName: string): object {
	const background = colors.background;
	const foreground = colors.foreground;
	const isDark = getLuminance(background) < 0.5;

	const error = colors.palette[1] ?? "#cc6666";
	const success = colors.palette[2] ?? "#98c379";
	const warning = colors.palette[3] ?? "#e5c07b";
	const link = colors.palette[4] ?? "#61afef";
	const accent = colors.palette[5] ?? "#c678dd";
	const accentAlt = colors.palette[6] ?? "#56b6c2";

	const muted = mixColors(foreground, background, 0.65);
	const dim = mixColors(foreground, background, 0.45);
	const borderMuted = mixColors(foreground, background, 0.25);

	const backgroundShift = isDark ? 12 : -12;
	const selectedBg = adjustBrightness(background, backgroundShift);
	const userMessageBg = adjustBrightness(background, Math.round(backgroundShift * 0.7));
	const toolPendingBg = adjustBrightness(background, Math.round(backgroundShift * 0.4));
	const toolSuccessBg = mixColors(background, success, 0.88);
	const toolErrorBg = mixColors(background, error, 0.88);
	const customMessageBg = mixColors(background, accent, 0.92);

	return {
		$schema:
			"https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/src/modes/interactive/theme/theme-schema.json",
		name: themeName,
		vars: {
			bg: background,
			fg: foreground,
			accent,
			accentAlt,
			link,
			error,
			success,
			warning,
			muted,
			dim,
			borderMuted,
			selectedBg,
			userMessageBg,
			toolPendingBg,
			toolSuccessBg,
			toolErrorBg,
			customMessageBg,
		},
		colors: {
			accent: "accent",
			border: "link",
			borderAccent: "accent",
			borderMuted: "borderMuted",
			success: "success",
			error: "error",
			warning: "warning",
			muted: "muted",
			dim: "dim",
			text: "",
			thinkingText: "muted",

			selectedBg: "selectedBg",
			scrollbarThumb: "selectedBg",
			userMessageBg: "userMessageBg",
			userMessageText: "",
			customMessageBg: "customMessageBg",
			customMessageText: "",
			customMessageLabel: "accent",
			toolPendingBg: "toolPendingBg",
			toolSuccessBg: "toolSuccessBg",
			toolErrorBg: "toolErrorBg",
			toolTitle: "",
			toolOutput: "muted",

			mdHeading: "warning",
			mdLink: "link",
			mdLinkUrl: "dim",
			mdCode: "accent",
			mdCodeBlock: "success",
			mdCodeBlockBorder: "muted",
			mdQuote: "muted",
			mdQuoteBorder: "muted",
			mdHr: "muted",
			mdListBullet: "accent",

			toolDiffAdded: "success",
			toolDiffRemoved: "error",
			toolDiffContext: "muted",

			syntaxComment: "muted",
			syntaxKeyword: "accent",
			syntaxFunction: "link",
			syntaxVariable: "accentAlt",
			syntaxString: "success",
			syntaxNumber: "accent",
			syntaxType: "accentAlt",
			syntaxOperator: "fg",
			syntaxPunctuation: "muted",

			thinkingOff: "borderMuted",
			thinkingMinimal: "muted",
			thinkingLow: "link",
			thinkingMedium: "accentAlt",
			thinkingHigh: "accent",
			thinkingXhigh: "accent",
			thinkingMax: "accent",

			bashMode: "success",
		},
		export: {
			pageBg: isDark ? adjustBrightness(background, -8) : adjustBrightness(background, 8),
			cardBg: background,
			infoBg: mixColors(background, warning, 0.88),
		},
	};
}

export function computeThemeHash(colors: KittyColors): string {
	const signature = [
		`bg=${colors.background}`,
		`fg=${colors.foreground}`,
		...Array.from({ length: 16 }, (_, index) => `c${index}=${colors.palette[index] ?? ""}`),
	].join("\n");
	return createHash("sha1").update(signature).digest("hex").slice(0, 8);
}

function cleanupOldKittyThemes(themesDirectory: string, keepFile: string): void {
	try {
		for (const file of readdirSync(themesDirectory)) {
			if (file !== keepFile && file.startsWith("kitty-sync-") && file.endsWith(".json")) {
				unlinkSync(join(themesDirectory, file));
			}
		}
	} catch {
		// Theme cleanup is best effort.
	}
}

async function syncTheme(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	configured: boolean,
	showNotification: boolean,
): Promise<boolean> {
	if (!ctx.hasUI) return false;

	const source = await readKittyColors(pi, configured);
	if (!source) {
		if (showNotification) {
			ctx.ui.notify(
				"Kitty colors unavailable. Run pi inside Kitty or check Kitty remote control/config.",
				"warning",
			);
		}
		return false;
	}

	const hash = computeThemeHash(source.colors);
	const themeName = `kitty-sync-${hash}`;
	const themeFile = `${themeName}.json`;
	const themesDirectory = join(getAgentDir(), "themes");
	const themePath = join(themesDirectory, themeFile);

	if (!existsSync(themesDirectory)) mkdirSync(themesDirectory, { recursive: true });
	if (!existsSync(themePath)) {
		writeFileSync(
			themePath,
			JSON.stringify(generatePiTheme(source.colors, themeName), null, 2),
			"utf8",
		);
	}
	cleanupOldKittyThemes(themesDirectory, themeFile);

	if (ctx.ui.theme.name !== themeName) {
		const result = ctx.ui.setTheme(themeName);
		if (!result.success) {
			ctx.ui.notify(`Kitty theme sync failed: ${result.error}`, "error");
			return false;
		}
	}

	if (showNotification) {
		ctx.ui.notify(`Pi theme synced from ${source.label}.`, "info");
	}
	return true;
}

export default function (pi: ExtensionAPI) {
	let pendingSync: Promise<boolean> | null = null;

	const runSync = (ctx: ExtensionContext, configured: boolean, showNotification: boolean) => {
		if (pendingSync) return pendingSync;
		pendingSync = syncTheme(pi, ctx, configured, showNotification).finally(() => {
			pendingSync = null;
		});
		return pendingSync;
	};

	pi.registerCommand("kitty-theme-sync", {
		description: "Sync pi theme with Kitty colors (optional: configured)",
		handler: async (args, ctx) => {
			const mode = args.trim().toLowerCase();
			if (mode && mode !== "configured") {
				ctx.ui.notify("Usage: /kitty-theme-sync [configured]", "warning");
				return;
			}
			await runSync(ctx, mode === "configured", true);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		await runSync(ctx, false, false);
	});
}
