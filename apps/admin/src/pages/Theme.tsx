// The theme page, from the Figma "Theme" screen: the accent colour with its
// contrast, the logo with its alt text, and a preview of the waiting card.
import { Box, Button, Flex, Image, Input, Stack, Text } from "@chakra-ui/react";
import { colors, fonts } from "@tryout/tokens";
import { Check, Trash2, TriangleAlert, Upload } from "lucide-react";
import { useRef, useState, type ChangeEvent } from "react";
import { DraftField } from "../components/Fields.tsx";
import { PageHeader } from "../components/PageHeader.tsx";
import { PendingActions } from "../components/PendingActions.tsx";
import { Problem } from "../components/Problem.tsx";
import { Section } from "../components/Section.tsx";
import { Card } from "../components/Card.tsx";
import { BASE } from "../navigation.ts";
import { useUploadAsset } from "../queries.ts";
import type { SettingsDocument, Theme as ThemeSettings } from "../settings/document.ts";
import { CARD_BACKGROUND, LOGO_TYPES, MAX_LOGO_BYTES, MIN_ACCENT_CONTRAST, contrastRatio, isHexColour } from "../settings/theme.ts";
import { strings } from "../strings.ts";
import { useDraft } from "../useDraft.tsx";

const T = strings.theme;
const DEFAULT_ACCENT = colors.brand.solid.toUpperCase();

type Edit = (update: (d: SettingsDocument) => void) => void;

/** The URL of a stored logo. */
export const assetUrl = (sha256: string) => `${BASE}/api/assets/${sha256}`;

/** Writes to the draft's theme, creating it when absent. */
function editTheme(edit: Edit, update: (theme: ThemeSettings) => void) {
  edit((d) => {
    d.theme ??= {};
    update(d.theme);
  });
}

/** The contrast of an accent on the embed card, and whether it is enough. */
function ContrastLine({ accent }: { accent: string }) {
  const ratio = contrastRatio(accent, CARD_BACKGROUND);
  const ok = ratio >= MIN_ACCENT_CONTRAST;

  return (
    <Flex mt="2" gap="1.5" align="center" color={ok ? "fg.muted" : "fg.error"} textStyle="text-xs" role="status">
      <Box color={ok ? "fg.success" : "fg.error"}>{ok ? <Check size={14} aria-hidden /> : <TriangleAlert size={14} aria-hidden />}</Box>
      {T.accent.ratio(ratio.toFixed(1))}
    </Flex>
  );
}

/** The accent: a colour picker, its hex value, and the way back to the default. */
function AccentCard({ accent, edit }: { accent: string | undefined; edit: Edit }) {
  const shown = accent ?? DEFAULT_ACCENT;
  const set = (value: string) => editTheme(edit, (t) => (t.accent = value));

  return (
    <Section title={T.accent.title} description={T.accent.description}>
      <Flex gap="3" align="flex-end">
        <Input
          type="color"
          aria-label={T.accent.picker}
          value={shown.toLowerCase()}
          onChange={(e) => set(e.target.value.toUpperCase())}
          w="10"
          h="10"
          p="0"
          borderWidth="0"
          cursor="pointer"
        />
        <Box w="200px">
          <DraftField label={T.accent.label} mono value={shown} format={String} parse={(t) => (isHexColour(t.trim()) ? t.trim().toUpperCase() : undefined)} invalid={T.accent.format} onCommit={set} />
        </Box>
        <Button variant="ghost" size="sm" h="10" disabled={accent === undefined} onClick={() => editTheme(edit, (t) => delete t.accent)}>
          {T.accent.useDefault(DEFAULT_ACCENT)}
        </Button>
      </Flex>
      {isHexColour(shown) && <ContrastLine accent={shown} />}
    </Section>
  );
}

/** A file's bytes in base64. */
function base64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ""));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

/** The logo: its preview, upload, replace and remove, and its alt text. */
function LogoCard({ logo, edit }: { logo: ThemeSettings["logo"]; edit: Edit }) {
  const upload = useUploadAsset();
  const picker = useRef<HTMLInputElement>(null);
  const [problem, setProblem] = useState<string | null>(null);

  /** Checks the picked file, stores it, then names it in the draft. */
  async function pick(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;

    if (!LOGO_TYPES[file.type]) return setProblem(T.logo.wrongType);
    if (file.size > MAX_LOGO_BYTES) return setProblem(T.logo.tooBig);
    setProblem(null);

    upload.mutate(await base64(file), {
      onSuccess: (sha256) => editTheme(edit, (t) => (t.logo = { asset: sha256, alt: t.logo?.alt ?? "" })),
    });
  }

  const choose = () => picker.current?.click();
  const uploadButton = (label: string) => (
    <Button variant="outline" size="sm" h="8" loading={upload.isPending} onClick={choose}>
      <Upload size={16} aria-hidden />
      {label}
    </Button>
  );

  return (
    <Section title={T.logo.title} description={T.logo.description}>
      <input ref={picker} type="file" accept={Object.keys(LOGO_TYPES).join(",")} hidden aria-label={T.logo.file} onChange={pick} />
      <Stack gap="4">
        <Flex p="4" gap="4" align="center" borderWidth="1px" borderStyle="dashed" borderColor="border.emphasized" borderRadius="l2">
          {logo?.asset ? (
            <>
              <Flex w="120px" h="12" bg="bg" borderRadius="l1" align="center" justify="center">
                <Image src={assetUrl(logo.asset)} alt={T.logo.preview} maxH="20px" maxW="100px" />
              </Flex>
              <Box flex="1" />
              {uploadButton(T.logo.replace)}
              <Button variant="ghost" size="sm" h="8" onClick={() => editTheme(edit, (t) => delete t.logo)}>
                <Trash2 size={16} aria-hidden />
                {T.logo.remove}
              </Button>
            </>
          ) : (
            <>
              <Text flex="1" color="fg.muted">
                {logo?.file ?? T.logo.none}
              </Text>
              {uploadButton(T.logo.upload)}
            </>
          )}
        </Flex>
        {problem && <Problem title={problem} />}
        {upload.isError && <Problem title={upload.error.message} />}
        {logo && (
          <DraftField
            label={T.logo.alt}
            help={T.logo.altHelp}
            value={logo.alt}
            format={String}
            parse={(t) => t}
            invalid=""
            problem={logo.alt.trim() ? undefined : T.logo.altMissing}
            onCommit={(alt) => editTheme(edit, (t) => t.logo && (t.logo.alt = alt))}
          />
        )}
      </Stack>
    </Section>
  );
}

/** The waiting card of the embed page, with the draft's accent and logo. */
function PreviewCard({ theme }: { theme: ThemeSettings }) {
  const accent = theme.accent && isHexColour(theme.accent) ? theme.accent : DEFAULT_ACCENT;

  return (
    <Section title={T.preview.title} description={T.preview.description}>
      <Card p="6" bg="bg.panel" maxW="360px" mx="auto" my="4" aria-hidden>
        {theme.logo?.asset && <Image src={assetUrl(theme.logo.asset)} alt="" h="20px" mb="4" />}
        <Text fontFamily={fonts.condensed} textStyle="display-ticket" color={accent}>
          {T.preview.position}
        </Text>
        <Text mt="4" textStyle="heading-lg">
          {T.preview.line}
        </Text>
        <Text mt="1" color="fg.muted">
          {T.preview.hint}
        </Text>
      </Card>
    </Section>
  );
}

/** The theme page. */
export function Theme() {
  const { document, active, edit } = useDraft();
  const theme = document?.theme ?? {};

  return (
    <>
      <PageHeader title={T.title} description={T.description} action={<PendingActions />} />

      {active.isError && (
        <Box px="8">
          <Problem title={strings.common.loadFailed} detail={active.error.message} />
        </Box>
      )}
      {document && (
        <Flex px="8" gap="6" align="flex-start">
          <Stack flex="1" minW="0" maxW="620px" gap="6">
            <AccentCard accent={theme.accent} edit={edit} />
            <LogoCard logo={theme.logo} edit={edit} />
          </Stack>
          <Box flex="1" minW="0">
            <PreviewCard theme={theme} />
          </Box>
        </Flex>
      )}
    </>
  );
}
