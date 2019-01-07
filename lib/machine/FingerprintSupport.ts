/*
 * Copyright © 2018 Atomist, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {
    addressSlackChannelsFromContext,
    editModes,
    GitProject,
    HandlerContext,
    logger,
    Project,
} from "@atomist/automation-client";
import {
    actionableButton,
    CommandListenerInvocation,
    ExtensionPack,
    Fingerprint,
    FingerprinterResult,
    Goal,
    metadata,
    PushImpactListener,
    PushImpactListenerInvocation,
    SoftwareDeliveryMachine,
} from "@atomist/sdm";
import { SlackMessage } from "@atomist/slack-messages";
import {
    Diff,
    FP,
    renderData,
    Vote,
} from "../../fingerprints/index";
import {
    checkFingerprintTarget,
    GitCoordinate,
    MessageMaker,
    MessageMakerParams,
    votes,
} from "../fingerprints/impact";
import { getNpmDepFingerprint } from "../fingerprints/npmDeps";
import {
    ApplyTargetFingerprintParameters,
    compileApplyAllFingerprintsCommand,
    compileApplyFingerprintCommand,
} from "../handlers/commands/applyFingerprint";
import { BroadcastFingerprintNudge } from "../handlers/commands/broadcast";
import {
    ListFingerprint,
    ListFingerprints,
} from "../handlers/commands/list";
import {
    DumpLibraryPreferences,
    ListFingerprintTargets,
    ListOneFingerprintTarget,
} from "../handlers/commands/showTargets";
import {
    DeleteTargetFingerprint,
    SelectTargetFingerprintFromCurrentProject,
    setNewTargetFingerprint,
    SetTargetFingerprint,
    SetTargetFingerprintFromLatestMaster,
    UpdateTargetFingerprint,
} from "../handlers/commands/updateTarget";
import { PullRequestImpactHandlerRegistration } from "../handlers/events/prImpactHandler";
import {
    forFingerprints,
    pushImpactHandler,
} from "../handlers/events/pushImpactHandler";
import { footer } from "../support/util";

function runFingerprints(fingerprinter: FingerprintRunner): PushImpactListener<FingerprinterResult> {
    return async (i: PushImpactListenerInvocation) => {
        return fingerprinter(i.project);
    };
}

type FingerprintRunner = (p: GitProject) => Promise<FP[]>;
export type ExtractFingerprint = (p: GitProject) => Promise<FP|FP[]>;
export type ApplyFingerprint = (p: GitProject, fp: FP) => Promise<boolean>;
export interface DiffSummary {title: string; description: string; }
export type DiffSummaryFingerprint = (diff: Diff, target: FP) => DiffSummary;

/**
 * different strategies can be used to handle PushImpactEventHandlers.
 */
export interface FingerprintHandler {
    selector: (name: FP) => boolean;
    diffHandler?: (context: HandlerContext, diff: Diff) => Promise<Vote>;
    handler?: (context: HandlerContext, diff: Diff) => Promise<Vote>;
    ballot?: (context: HandlerContext, votes: Vote[], coord: GitCoordinate, channel: string) => Promise<any>;
}

/**
 * permits customization of EditModes in the FingerprintImpactHandlerConfig
 */
export type EditModeMaker = (cli: CommandListenerInvocation<ApplyTargetFingerprintParameters>, project?: Project) => editModes.EditMode;

/**
 * customize the out of the box strategy for monitoring when fingerprints are out
 * of sync with a target.
 */
export interface FingerprintImpactHandlerConfig {
    complianceGoal?: Goal;
    complianceGoalFailMessage?: string;
    transformPresentation: EditModeMaker;
    messageMaker: MessageMaker;
}

/**
 * each new class of Fingerprints must implement this interface and pass the
 */
export interface FingerprintRegistration {
    selector: (name: FP) => boolean;
    extract: ExtractFingerprint;
    apply?: ApplyFingerprint;
    summary?: DiffSummaryFingerprint;
}

/**
 * all strategies for handler FingerprintImpact Events can configure themselves when this pack starts up
 */
export type RegisterFingerprintImpactHandler = (sdm: SoftwareDeliveryMachine, registrations: FingerprintRegistration[]) => FingerprintHandler;

/**
 * register a new Fingeprint
 *
 * @param name name of the new Fingerprint
 * @param extract function to extract the Fingerprint from a cloned code base
 * @param apply function to apply an external Fingerprint to a cloned code base
 */
export function register(name: string, extract: ExtractFingerprint, apply?: ApplyFingerprint): FingerprintRegistration {
    return {
        selector: (fp: FP) => (fp.name === name),
        extract,
        apply,
    };
}

function orDefault<T>(cb: () => T, x: T): T {
    try {
        return cb();
    } catch (y) {
        return x;
    }
}

export function oneFingerprint(params: MessageMakerParams, vote: Vote) {

    return {
        title: orDefault(() => vote.summary.title, "New Target"),
        text: orDefault(() => vote.summary.description, vote.text),
        color: "#45B254",
        fallback: "Fingerprint Update",
        mrkdwn_in: ["text"],
        actions: [
            actionableButton(
                { text: "Update project" },
                params.editProject,
                {
                    msgId: params.msgId,
                    fingerprint: vote.fpTarget.name,
                    targets: {
                        owner: vote.diff.owner,
                        repo: vote.diff.repo,
                        branch: vote.diff.branch,
                    },
                } as any),
            actionableButton(
                { text: "Set New Target" },
                params.mutateTarget,
                {
                    msgId: params.msgId,
                    name: vote.fingerprint.name,
                    sha: vote.fingerprint.sha,
                },
            ),
        ],
        footer: footer(),
    };
}

export function applyAll(params: MessageMakerParams) {
    return {
        title: "apply all",
        text: "apply all",
        color: "45B254",
        fallback: "Fingerprint Update",
        mrkdwn_in: ["text"],
        actions: [
            actionableButton(
                { text: "Apply All" },
                params.editAllProjects,
                {
                    msgId: params.msgId,
                    fingerprints: params.voteResults.failedVotes.map(vote => vote.fpTarget.name).join(","),
                    targets: {
                        owner: params.coord.owner,
                        repo: params.coord.repo,
                        branch: params.coord.branch,
                    },
                } as any,
            ),
        ],
    };
}

// default implementation
export const messageMaker: MessageMaker = async params => {

    const message: SlackMessage = {
        attachments: [
            ...params.voteResults.failedVotes.map( vote => oneFingerprint(params, vote) ),
        ],
    };

    if (params.voteResults.failedVotes.length > 1) {
        message.attachments.push(applyAll(params));
    }

    return params.ctx.messageClient.send(
        message,
        await addressSlackChannelsFromContext(params.ctx, params.channel),
        // {id: params.msgId} if you want to update messages if the target goal has not changed
        {id: undefined},
    );
};

export function fingerprintImpactHandler( config: FingerprintImpactHandlerConfig ): RegisterFingerprintImpactHandler {
    return  (sdm: SoftwareDeliveryMachine, registrations: FingerprintRegistration[]) => {
        // set goal Fingerprints
        //   - first can be added as an option when difference is noticed (uses our api to update the fingerprint)
        //   - second is a default intent
        //   - TODO:  third is just for resetting
        //   - both use askAboutBroadcast to generate an actionable message pointing at BroadcastFingerprintNudge
        sdm.addCommand(UpdateTargetFingerprint);
        sdm.addCommand(SetTargetFingerprintFromLatestMaster);
        sdm.addCommand(DeleteTargetFingerprint);

        // standard actionable message embedding ApplyTargetFingerprint
        sdm.addCommand(BroadcastFingerprintNudge);

        // this is the fingerprint editor
        // sdm.addCodeTransformCommand(applyTargetFingerprint(registrations, config.transformPresentation));

        sdm.addCommand(ListFingerprints);
        sdm.addCommand(ListFingerprint);
        sdm.addCommand(SelectTargetFingerprintFromCurrentProject);

        sdm.addCommand(compileApplyFingerprintCommand(registrations, config.transformPresentation, sdm));
        sdm.addCommand(compileApplyAllFingerprintsCommand(registrations, config.transformPresentation, sdm));

        return {
            selector: fp => true,
            handler: async (ctx, diff) => {
                const v: Vote = await checkFingerprintTarget(ctx, diff, config, registrations);
                return v;
            },
            ballot: votes(config),
        };
    };
}

export function checkCljCoordinatesImpactHandler(): RegisterFingerprintImpactHandler {
    return (sdm: SoftwareDeliveryMachine) => {

        return {
            selector: forFingerprints("clojure-project-coordinates"),
            diffHandler: (ctx, diff) => {
                return setNewTargetFingerprint(
                    ctx,
                    getNpmDepFingerprint(diff.to.data.name, diff.to.data.version),
                    diff.channel);
            },
        };
    };
}

export function checkNpmCoordinatesImpactHandler(): RegisterFingerprintImpactHandler {
    return (sdm: SoftwareDeliveryMachine) => {

        return {
            selector: forFingerprints("npm-project-coordinates"),
            diffHandler: (ctx, diff) => {
                return setNewTargetFingerprint(
                    ctx,
                    getNpmDepFingerprint(diff.to.data.name, diff.to.data.version),
                    diff.channel);
            },
        };
    };
}

export function simpleImpactHandler(
    handler: (context: HandlerContext, diff: Diff) => Promise<any>,
    ...names: string[]): RegisterFingerprintImpactHandler {
    return (sdm: SoftwareDeliveryMachine) => {
        return {
            selector: forFingerprints(...names),
            diffHandler: handler,
        };
    };
}

// TODO error handling goes here
function fingerprintRunner(fingerprinters: FingerprintRegistration[]): FingerprintRunner {
    return async (p: GitProject) => {

        let fps: FP[] = new Array<FP>();

        for (const fingerprinter of fingerprinters) {
            try {
                const fp = await fingerprinter.extract(p);
                if (fp && !(fp instanceof Array)) {
                    fps.push(fp);
                } else if (fp) {
                    fps = fps.concat(fp);
                }
            } catch (e) {
                logger.error(e);
            }
        }

        logger.info(renderData(fps));
        return fps;
    };
}

/**
 *
 *
 * @param goal use this Goal to run Fingeprints
 * @param fingerprinters registrations for each class of supported Fingerprints
 * @param handlers different strategies for handling fingeprint push impact events
 */
export function fingerprintSupport(
    goal: Fingerprint,
    fingerprinters: FingerprintRegistration[],
    ...handlers: RegisterFingerprintImpactHandler[]): ExtensionPack {

    goal.with({
        name: "fingerprinter",
        action: runFingerprints(fingerprintRunner(fingerprinters)),
    });

    return {
        ...metadata(),
        configure: (sdm: SoftwareDeliveryMachine) => {
            configure( sdm, handlers, fingerprinters);
        },
    };
}

function configure(sdm: SoftwareDeliveryMachine, handlers: RegisterFingerprintImpactHandler[], fpRegistraitons: FingerprintRegistration[]): void {

    // Fired on every Push after Fingerprints are uploaded
    sdm.addEvent(pushImpactHandler(handlers.map(h => h(sdm, fpRegistraitons))));

    // Fired on each PR after Fingerprints are uploaded
    sdm.addEvent(PullRequestImpactHandlerRegistration);

    sdm.addCommand(SetTargetFingerprint);
    sdm.addCommand(DumpLibraryPreferences);
    sdm.addCommand(ListFingerprintTargets);
    sdm.addCommand(ListOneFingerprintTarget);
}
