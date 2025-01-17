/*
 * Copyright © 2019 Atomist, Inc.
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
    FailurePromise,
    HandlerContext,
    logger,
    MappedParameter,
    MappedParameters,
    menuForCommand,
    Parameter,
    Parameters,
} from "@atomist/automation-client";
import {
    actionableButton,
    CommandHandlerRegistration,
    slackFooter,
} from "@atomist/sdm";
import { SlackMessage } from "@atomist/slack-messages";
import {
    deleteGoalFingerprint,
    FP,
    setGoalFingerprint,
    setTargetFingerprint,
    Vote,
} from "../../../fingerprints/index";
import {
    queryFingerprintBySha,
    queryFingerprintOnShaByName,
    queryFingerprintsByBranchRef,
} from "../../adhoc/fingerprints";
import {
    mutatePreference,
    queryPreferences,
} from "../../adhoc/preferences";
import {
    GetAllFingerprintsOnSha,
    GetFingerprintOnShaByName,
} from "../../typings/types";
import { askAboutBroadcast } from "./broadcast";

@Parameters()
export class SetTargetFingerprintFromLatestMasterParameters {
    @MappedParameter(MappedParameters.GitHubOwner)
    public owner: string;

    @MappedParameter(MappedParameters.GitHubRepository)
    public repo: string;

    @MappedParameter(MappedParameters.GitHubRepositoryProvider)
    public providerId: string;

    @Parameter({ required: true })
    public fingerprint: string;

    @Parameter({ required: false })
    public branch: string;
}

export const SetTargetFingerprintFromLatestMaster: CommandHandlerRegistration<SetTargetFingerprintFromLatestMasterParameters> = {
    name: "SetTargetFingerprintFromLatestMaster",
    intent: "setFingerprintGoal",
    description: "set a new target for a team to consume a particular version",
    paramsMaker: SetTargetFingerprintFromLatestMasterParameters,
    listener: async cli => {

        const branch = cli.parameters.branch || "master";

        const query: GetFingerprintOnShaByName.Query =
            await (queryFingerprintOnShaByName(cli.context.graphClient))(
                cli.parameters.repo,
                cli.parameters.owner,
                branch,
                cli.parameters.fingerprint,
            );
        const sha: string = query.Repo[0].branches[0].commit.fingerprints[0].sha;
        logger.info(`found sha ${sha}`);
        if (sha) {
            await setGoalFingerprint(
                queryPreferences(cli.context.graphClient),
                queryFingerprintBySha(cli.context.graphClient),
                mutatePreference(cli.context.graphClient),
                cli.parameters.fingerprint,
                sha,
                cli.context.source.slack.user.id,
            );
            return askAboutBroadcast(cli, cli.parameters.fingerprint, "version", sha);
        } else {
            return FailurePromise;
        }
    },
};

@Parameters()
export class UpdateTargetFingerprintParameters {

    @Parameter({ required: false, displayable: false })
    public msgId?: string;

    @Parameter({ required: true })
    public sha: string;

    @Parameter({ required: true })
    public name: string;
}

// set target fingerprint using name an sha of existing fingerprint
export const UpdateTargetFingerprint: CommandHandlerRegistration<UpdateTargetFingerprintParameters> = {
    name: "RegisterTargetFingerprint",
    description: "set a new target for a team to consume a particular version",
    paramsMaker: UpdateTargetFingerprintParameters,
    listener: async cli => {
        await cli.context.messageClient.respond(
            `updating the goal state for all ${cli.parameters.name} fingerprints (initiated by user <@${cli.context.source.slack.user.id}> )`);
        await setGoalFingerprint(
            queryPreferences(cli.context.graphClient),
            queryFingerprintBySha(cli.context.graphClient),
            mutatePreference(cli.context.graphClient),
            cli.parameters.name,
            cli.parameters.sha,
            cli.context.source.slack.user.id,
        );
        return askAboutBroadcast(cli, cli.parameters.name, "version", cli.parameters.sha);
    },
};

@Parameters()
export class SetTargetFingerprintParameters {

    @Parameter({ required: true, displayable: false, control: "textarea", pattern: /.*/ })
    public fp: string;
}

// set target fingerprint to a new non-existing Fingerprint
export const SetTargetFingerprint: CommandHandlerRegistration<SetTargetFingerprintParameters> = {
    name: "SetTargetFingerprint",
    description: "set a target fingerprint",
    paramsMaker: SetTargetFingerprintParameters,
    listener: async cli => {
        logger.info(`set target fingerprint for ${cli.parameters.fp}`);
        const fp = {
            user: { id: cli.context.source.slack.user.id },
            ...JSON.parse(cli.parameters.fp),
        };
        await setTargetFingerprint(
            queryPreferences(cli.context.graphClient),
            mutatePreference(cli.context.graphClient),
            JSON.stringify(fp));

        return askAboutBroadcast(cli, fp.name, fp.data[1], fp.sha);
    },
};

@Parameters()
export class DeleteTargetFingerprintParameters {
    @Parameter({ required: true })
    public name: string;
}

export const DeleteTargetFingerprint: CommandHandlerRegistration<DeleteTargetFingerprintParameters> = {
    name: "DeleteTargetFingerprint",
    intent: "deleteFingerprintTarget",
    description: "remove the team target for a particular fingerprint",
    paramsMaker: DeleteTargetFingerprintParameters,
    listener: async cli => {
        await cli.context.messageClient.respond(`updating the goal state for all ${cli.parameters.name} fingerprints`);
        await deleteGoalFingerprint(
            queryPreferences(cli.context.graphClient),
            mutatePreference(cli.context.graphClient),
            cli.parameters.name,
        );
    },
};

export async function setNewTargetFingerprint(ctx: HandlerContext,
                                              fp: FP,
                                              channel: string): Promise<Vote> {
    const message: SlackMessage = {
        attachments: [
            {
                text: `Shall we update the target version of \`${fp.name}\` for all projects?`,
                fallback: "none",
                actions: [
                    actionableButton<any>(
                        {
                            text: "Set Target",
                        },
                        SetTargetFingerprint,
                        {
                            fp: JSON.stringify(fp),
                        },
                    ),
                ],
                color: "#ffcc00",
                footer: slackFooter(),
                callback_id: "atm-confirm-done",
            },
        ],
    };
    await ctx.messageClient.addressChannels(message, channel);

    return {abstain: true};
}

@Parameters()
export class SelectTargetFingerprintFromCurrentProjectParameters {
    @MappedParameter(MappedParameters.GitHubOwner)
    public owner: string;

    @MappedParameter(MappedParameters.GitHubRepository)
    public repo: string;

    @MappedParameter(MappedParameters.GitHubRepositoryProvider)
    public providerId: string;

    @Parameter({ required: false, description: "pull fingerprints from a branch ref" })
    public branch: string;
}

export const SelectTargetFingerprintFromCurrentProject: CommandHandlerRegistration<SelectTargetFingerprintFromCurrentProjectParameters> = {
    name: "SelectTargetFingerprintFromCurrentProject",
    intent: "setFingerprintTarget",
    description: "select a fingerprint in this project to become a target fingerprint",
    paramsMaker: SelectTargetFingerprintFromCurrentProjectParameters,
    listener: async cli => {

        // this has got to be wrong.  ugh
        const branch: string = cli.parameters.branch || "master";

        const query: GetAllFingerprintsOnSha.Query = await queryFingerprintsByBranchRef(cli.context.graphClient)(
            cli.parameters.repo,
            cli.parameters.owner,
            branch);
        const fps: GetAllFingerprintsOnSha.Fingerprints[] = query.Repo[0].branches[0].commit.fingerprints;

        const message: SlackMessage = {
            attachments: [
                {
                    text: "Choose one of the current fingerprints",
                    fallback: "select fingerprint",
                    actions: [
                        menuForCommand(
                            {
                                text: "select fingerprint",
                                options: [
                                    ...fps.map(x => {
                                        return {
                                            value: x.name,
                                            text: x.name,
                                        };
                                    }),
                                ],
                            },
                            SetTargetFingerprintFromLatestMaster.name,
                            "fingerprint",
                            {
                                owner: cli.parameters.owner,
                                repo: cli.parameters.repo,
                                branch,
                                providerId: cli.parameters.providerId,
                            },
                        ),
                    ],
                },
            ],
        };

        return cli.addressChannels(message);
    },
};
