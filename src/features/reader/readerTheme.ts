export const currentReaderTheme = {
	background: "#F1E2C9",
	text: "#111111",
};

export const readerControlFadeDuration = 180;
export const readerContentPaddingTop = 100;
export const readerContentPaddingBottom = 48;

export const readerTheme = {
	html: {
		background: `${currentReaderTheme.background} !important`,
		"-webkit-text-size-adjust": "100% !important",
		"text-size-adjust": "100% !important",
	},
	body: {
		background: currentReaderTheme.background,
		"background-color": `${currentReaderTheme.background} !important`,
		color: `${currentReaderTheme.text} !important`,
		"font-size": "20px !important",
		"line-height": "1.75 !important",
		margin: "0 !important",
		padding: "16px 22px !important",
		"box-sizing": "border-box !important",
	},
};
