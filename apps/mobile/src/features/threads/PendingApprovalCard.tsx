import { Button } from "../../components/ui/Button";
import type {
  ProviderApprovalDecision,
  ProviderApprovalOption,
  RuntimeRequestId,
} from "@t3tools/contracts";
import { ScrollView, View } from "react-native";
import { useState } from "react";
import { SafeAreaView } from "react-native-safe-area-context";
import { Sheet } from "../../components/ui/Sheet";
import { SourceFileSurface } from "../files/SourceFileSurface";

import { AppText as Text } from "../../components/ui/AppText";
import type { PendingApproval } from "../../lib/threadActivity";

export interface PendingApprovalCardProps {
  readonly canOperateThread: boolean;
  readonly approval: PendingApproval;
  readonly respondingApprovalId: RuntimeRequestId | null;
  readonly onRespond: (
    requestId: RuntimeRequestId,
    decision: ProviderApprovalDecision,
  ) => Promise<unknown>;
}

const DEFAULT_APPROVAL_OPTIONS: ReadonlyArray<ProviderApprovalOption> = [
  { decision: "accept", label: "Allow once" },
  { decision: "acceptForSession", label: "Allow session" },
  { decision: "decline", label: "Decline" },
];

export function PendingApprovalCard(props: PendingApprovalCardProps) {
  const [reviewOpenFor, setReviewOpenFor] = useState<RuntimeRequestId | null>(null);
  const reviewOpen = reviewOpenFor === props.approval.requestId;
  const [reviewedRequestId, setReviewedRequestId] = useState<RuntimeRequestId | null>(null);
  const options: ReadonlyArray<ProviderApprovalOption> =
    props.approval.options ?? DEFAULT_APPROVAL_OPTIONS;
  const warning = options.find((option) => option.warning)?.warning;
  const canRespond = props.approval.responseCapability === "live";
  const disabled = !canRespond || props.respondingApprovalId === props.approval.requestId;
  const longRequest = (props.approval.detail?.length ?? 0) > 2_000;
  const actions = (
    <View className="flex-row flex-wrap gap-2.5">
      {options.map((option) => (
        <Button
          key={option.decision}
          label={option.label}
          tone={
            option.decision === "accept"
              ? "primary"
              : option.decision === "decline"
                ? "danger"
                : "secondary"
          }
          disabled={
            disabled ||
            !props.canOperateThread ||
            (longRequest &&
              reviewedRequestId !== props.approval.requestId &&
              (option.decision === "accept" ||
                option.decision === "acceptForSession" ||
                option.decision === "acceptAlways"))
          }
          onPress={() => {
            setReviewOpenFor(null);
            void props.onRespond(props.approval.requestId, option.decision);
          }}
        />
      ))}
    </View>
  );
  return (
    <View className="gap-2.5 rounded-[20px] border border-border bg-card-alt p-4">
      <Text className="font-t3-bold text-2xs uppercase tracking-[1.1px] text-foreground-secondary">
        Approval needed
      </Text>
      <Text className="font-t3-bold text-lg text-foreground">
        {props.approval.appName ?? props.approval.requestKind}
      </Text>
      {props.approval.detail ? (
        longRequest ? (
          <Text className="font-sans text-sm leading-normal text-foreground-secondary">
            Review the complete request before approving (
            {props.approval.detail.length.toLocaleString()} characters).
          </Text>
        ) : (
          <ScrollView style={{ maxHeight: 120 }} nestedScrollEnabled>
            <Text selectable className="font-sans text-sm leading-normal text-foreground-secondary">
              {props.approval.detail}
            </Text>
          </ScrollView>
        )
      ) : null}
      {props.approval.detail ? (
        <Button
          label="Review complete request"
          tone="secondary"
          onPress={() => {
            setReviewedRequestId(props.approval.requestId);
            setReviewOpenFor(props.approval.requestId);
          }}
        />
      ) : null}
      {!canRespond ? (
        <Text className="font-sans text-sm leading-5 text-foreground-muted">
          The provider process for this request is no longer available. Interrupt or restart the run
          to continue.
        </Text>
      ) : null}
      {warning ? (
        <Text className="font-sans text-xs leading-normal text-warning-foreground">{warning}</Text>
      ) : null}
      {actions}
      {!props.canOperateThread ? (
        <Text className="font-sans text-xs text-foreground-muted">
          This connection cannot respond to approvals.
        </Text>
      ) : null}
      {reviewOpen && props.approval.detail ? (
        <Sheet
          key={props.approval.requestId}
          title="Approval request"
          onClose={() => setReviewOpenFor(null)}
        >
          <View className="flex-1">
            <SourceFileSurface
              contents={props.approval.detail}
              path={`approval-${props.approval.requestId}.txt`}
              selectable
            />
            <SafeAreaView edges={["bottom"]} className="border-t border-border bg-card-alt p-4">
              {actions}
            </SafeAreaView>
          </View>
        </Sheet>
      ) : null}
    </View>
  );
}
