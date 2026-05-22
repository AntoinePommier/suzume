export type DictionaryTapMessage = {
	type: "dictionary-tap";
	payload: {
		character: string;
		before: string;
		after: string;
		context: string;
	};
};

export type DictionarySelection = DictionaryTapMessage["payload"];

export type DictionaryCloseMessage = {
	type: "dictionary-close";
};

export type DictionaryBridgeMessage =
	| DictionaryTapMessage
	| DictionaryCloseMessage;
