// A button that saves a file built in the browser, waiting while it is built
// and saying so when it fails.
import { Button, Flex, Text } from "@chakra-ui/react";
import { FileDown } from "lucide-react";
import { useState } from "react";
import { strings } from "../strings.ts";

/** Runs `run` on click; the button waits meanwhile, and a failure shows beside it. */
export function DownloadButton({ label, run }: { label: string; run: () => Promise<void> }) {
  const [state, setState] = useState<"idle" | "busy" | "failed">("idle");

  /** Builds and saves the file. */
  const click = () => {
    setState("busy");
    run().then(
      () => setState("idle"),
      () => setState("failed"),
    );
  };

  return (
    <Flex gap="2" align="center">
      <Button variant="ghost" size="sm" h="10" loading={state === "busy"} onClick={click}>
        <FileDown size={16} aria-hidden />
        {label}
      </Button>
      {state === "failed" && (
        <Text role="alert" textStyle="text-xs" color="fg.error">
          {strings.common.downloadFailed}
        </Text>
      )}
    </Flex>
  );
}
