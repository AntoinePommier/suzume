import jszipSource from "@epubjs-react-native/core/lib/module/jszip";

export type EpubZipEntry = {
	async(type: "base64" | "text"): Promise<string>;
};

export type EpubZip = {
	file(path: string): EpubZipEntry | null;
};

type JSZipConstructor = {
	loadAsync(data: string, options: { base64: boolean }): Promise<EpubZip>;
};

let JSZipConstructorCache: JSZipConstructor | null = null;

function getJSZipConstructor() {
	if (JSZipConstructorCache) {
		return JSZipConstructorCache;
	}

	const scope: { JSZip?: JSZipConstructor } = {};
	const source =
		typeof jszipSource === "string"
			? jszipSource
			: (jszipSource as { default?: string }).default;

	if (!source) {
		throw new Error("Unable to load EPUB parser source");
	}

	const createJSZip = new Function(
		"scope",
		`
			var window = scope;
			var global = scope;
			var self = scope;
			var module = { exports: undefined };
			var exports = module.exports;

			${source}

			return module.exports || scope.JSZip;
		`,
	);

	const JSZipConstructor = createJSZip(scope) as JSZipConstructor | undefined;

	if (!JSZipConstructor) {
		throw new Error("Unable to initialize EPUB parser");
	}

	JSZipConstructorCache = JSZipConstructor;

	return JSZipConstructorCache;
}

export async function loadEpubZip(bookBase64: string) {
	const JSZip = getJSZipConstructor();

	return JSZip.loadAsync(bookBase64, { base64: true });
}
