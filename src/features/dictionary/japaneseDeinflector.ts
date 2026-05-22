import {
	japaneseDeinflectionForms,
	japaneseDeinflectionRules,
	japaneseInflectionTypes,
	type JapaneseDeinflectionForm,
	type JapaneseDeinflectionRule,
	type JapaneseInflectionType,
} from "./japaneseDeinflectionRules";

export type JapaneseDeinflection = {
	surfaceForm: string;
	dictionaryForm: string;
	reasons: string[];
	rules: string[];
};

type DeinflectionRecord = JapaneseDeinflection & {
	inflectionType: JapaneseInflectionType;
};

type RegularRuleGroup = "adjective" | "ichidan" | "godan";
type IrregularRuleGroup = "suru" | "kuru" | "special" | "iku";

const formNames = Object.fromEntries(
	Object.entries(japaneseDeinflectionForms).map(([name, value]) => [
		value,
		name.toLowerCase().replaceAll("_", "-"),
	]),
) as Record<JapaneseDeinflectionForm, string>;

const auxAdjectiveForms = new Set<JapaneseDeinflectionForm>([
	japaneseDeinflectionForms.TAI,
	japaneseDeinflectionForms.SOU,
	japaneseDeinflectionForms.NEGATIVE,
]);

const ichidanStemEndings = new Set([
	"い",
	"き",
	"ぎ",
	"し",
	"じ",
	"ち",
	"ぢ",
	"に",
	"ひ",
	"び",
	"ぴ",
	"み",
	"り",
	"イ",
	"キ",
	"ギ",
	"シ",
	"ジ",
	"チ",
	"ヂ",
	"ニ",
	"ヒ",
	"ビ",
	"ピ",
	"ミ",
	"リ",
	"え",
	"け",
	"げ",
	"せ",
	"ぜ",
	"て",
	"で",
	"ね",
	"へ",
	"べ",
	"ぺ",
	"め",
	"れ",
	"エ",
	"ケ",
	"ゲ",
	"セ",
	"ゼ",
	"テ",
	"デ",
	"ネ",
	"ヘ",
	"ベ",
	"ペ",
	"メ",
	"レ",
]);

function formName(form: JapaneseDeinflectionForm) {
	return formNames[form] ?? String(form);
}

function hasIchidanStemEnding(word: string) {
	const characters = Array.from(word);

	if (characters.length <= 1) {
		return false;
	}

	return ichidanStemEndings.has(characters[characters.length - 2]);
}

function deinflectWord(word: string, rule: JapaneseDeinflectionRule) {
	const [inflection, base] = rule;

	if (!word.endsWith(inflection)) {
		return null;
	}

	const deinflected = `${word.slice(0, word.length - inflection.length)}${base}`;

	return Array.from(deinflected).length > 1 ? deinflected : null;
}

function pushUnique(records: DeinflectionRecord[], record: DeinflectionRecord) {
	const key = `${record.dictionaryForm}\u0000${record.rules.join("\u0001")}`;

	if (
		records.some(
			(existing) =>
				`${existing.dictionaryForm}\u0000${existing.rules.join("\u0001")}` ===
				key,
		)
	) {
		return;
	}

	records.push(record);
}

function applyRegularRules(
	records: DeinflectionRecord[],
	group: RegularRuleGroup,
	inflectionType: JapaneseInflectionType,
	processAsAdded: boolean,
) {
	const initialSize = records.length;

	for (let index = 0; index < records.length; index += 1) {
		if (!processAsAdded && index >= initialSize) {
			break;
		}

		const record = records[index];

		for (const rule of japaneseDeinflectionRules[group]) {
			const [, , form] = rule;

			if (
				record.inflectionType === japaneseInflectionTypes.ADJECTIVE &&
				!auxAdjectiveForms.has(form)
			) {
				continue;
			}

			const dictionaryForm = deinflectWord(record.dictionaryForm, rule);

			if (!dictionaryForm) {
				continue;
			}

			if (
				inflectionType === japaneseInflectionTypes.ICHIDAN &&
				!hasIchidanStemEnding(dictionaryForm)
			) {
				continue;
			}

			pushUnique(records, {
				surfaceForm: record.surfaceForm,
				dictionaryForm,
				reasons: [formName(form), ...record.reasons],
				rules: [group, ...record.rules],
				inflectionType,
			});
		}
	}
}

function applyIrregularRules(
	records: DeinflectionRecord[],
	group: IrregularRuleGroup,
	inflectionType: JapaneseInflectionType,
) {
	const initialSize = records.length;

	for (let index = 0; index < initialSize; index += 1) {
		const record = records[index];

		for (const rule of japaneseDeinflectionRules[group]) {
			const [inflection, base, form] = rule;

			if (record.dictionaryForm !== inflection) {
				continue;
			}

			pushUnique(records, {
				surfaceForm: record.surfaceForm,
				dictionaryForm: base,
				reasons: [formName(form), ...record.reasons],
				rules: [group, ...record.rules],
				inflectionType,
			});
		}
	}
}

function applySuruSuffixRules(records: DeinflectionRecord[]) {
	const initialSize = records.length;

	for (let index = 0; index < initialSize; index += 1) {
		const record = records[index];

		for (const rule of japaneseDeinflectionRules.suru) {
			const [, , form] = rule;
			const dictionaryForm = deinflectWord(record.dictionaryForm, rule);

			if (!dictionaryForm) {
				continue;
			}

			pushUnique(records, {
				surfaceForm: record.surfaceForm,
				dictionaryForm,
				reasons: [formName(form), ...record.reasons],
				rules: ["suru", ...record.rules],
				inflectionType: japaneseInflectionTypes.SURU,
			});
		}
	}
}

function hasBogusEnding(word: string) {
	return japaneseDeinflectionRules.bogus.some((ending) => word.endsWith(ending));
}

export function deinflectJapaneseTerm(source: string): JapaneseDeinflection[] {
	const records: DeinflectionRecord[] = [
		{
			surfaceForm: source,
			dictionaryForm: source,
			reasons: [],
			rules: [],
			inflectionType: japaneseInflectionTypes.UNINFLECTABLE,
		},
	];

	applyRegularRules(
		records,
		"adjective",
		japaneseInflectionTypes.ADJECTIVE,
		true,
	);
	applyRegularRules(records, "ichidan", japaneseInflectionTypes.ICHIDAN, true);
	applyRegularRules(records, "godan", japaneseInflectionTypes.GODAN, false);

	applySuruSuffixRules(records);
	applyIrregularRules(records, "kuru", japaneseInflectionTypes.KURU);
	applyIrregularRules(records, "special", japaneseInflectionTypes.SPECIAL);
	applyIrregularRules(records, "iku", japaneseInflectionTypes.IKU);

	return records
		.filter(
			(record) =>
				record.reasons.length === 0 || !hasBogusEnding(record.dictionaryForm),
		)
		.map(({ inflectionType: _inflectionType, ...record }) => record);
}
