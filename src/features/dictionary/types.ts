export type DictionaryTapMessage = {
	type: "dictionary-tap";
	payload: {
		text: string;
	};
};

export type DictionaryCloseMessage = {
	type: "dictionary-close";
};

export type DictionaryBridgeMessage =
	| DictionaryTapMessage
	| DictionaryCloseMessage;
