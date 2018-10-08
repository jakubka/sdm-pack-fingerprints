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
    GitProject,
    GraphClient,
    guid,
    HandlerContext,
    logger,
    MappedParameter,
    MappedParameters,
    menuForCommand,
    NoParameters,
    Parameter,
    Parameters,
    PullRequest,
    QueryNoCacheOptions,
    Secret,
    SlackFileMessage,
} from "@atomist/automation-client";
import * as goals from "@atomist/clj-editors";
import {
    actionableButton,
    AutoMergeMode,
    CodeInspection,
    CodeInspectionRegistration,
    CodeTransform,
    CodeTransformRegistration,
    CommandHandlerRegistration,
    CommandListenerInvocation,
} from "@atomist/sdm";
import {
    bold,
    codeLine,
    italic,
    SlackMessage,
    user,
} from "@atomist/slack-messages";
import { footer } from "../../support/util";
import {
    ChatTeamById,
    ChatTeamPreferences,
    FindLinkedReposWithFingerprint,
    SetTeamPreference,
} from "../../typings/types";

export function queryPreferences(graphClient: GraphClient): () => Promise<any> {
    return () => {
        return graphClient.query<ChatTeamPreferences.Query, ChatTeamPreferences.Variables>(
            { name: "chatTeamPreferences", options: QueryNoCacheOptions },
        );
    };
}

const queryChatTeamById = async (graphClient: GraphClient, teamid: string): Promise<string> => {
    return graphClient.query<ChatTeamById.Query, ChatTeamById.Variables>(
        {
            name: "chatTeamById",
            variables: { id: teamid },
        },
    ).then(
        result => {
            return result.Team[0].chatTeams[0].id;
        },
    );
};

export function queryFingerprints(graphClient: GraphClient): (name: string) => Promise<any> {
    return async name => {
        return graphClient.query<FindLinkedReposWithFingerprint.Query, FindLinkedReposWithFingerprint.Variables>(
            {
                name: "findLinkedReposWithFingerprint",
                options: QueryNoCacheOptions,
                variables: {
                    name,
                },
            },
        );
    };
}

function mutateIgnores(graphClient: GraphClient): (chatTeamId: string, prefsAsJson: string) => Promise<any> {
    return (chatTeamId, prefsAsJson): Promise<any> => {
        return graphClient.mutate<SetTeamPreference.Mutation, SetTeamPreference.Variables>(
            {
                name: "setTeamPreference",
                variables: {
                    name: "fingerprints.deps.ignore",
                    value: prefsAsJson,
                    team: chatTeamId,
                },
            },
        );
    };
}

function mutatePreference(graphClient: GraphClient): (chatTeamId: string, prefsAsJson: string) => Promise<any> {
    return (chatTeamId, prefsAsJson): Promise<any> => {
        return graphClient.mutate<SetTeamPreference.Mutation, SetTeamPreference.Variables>(
            {
                name: "setTeamPreference",
                variables: {
                    name: "atomist:fingerprints:clojure:project-deps",
                    value: prefsAsJson,
                    team: chatTeamId,
                },
            },
        );
    };
}

// -------------------------------------
// ignore library target
// -------------------------------------

@Parameters()
export class IgnoreVersionParameters {

    @Parameter({ required: false, displayable: false })
    public msgId?: string;

    @MappedParameter(MappedParameters.GitHubOwner)
    public owner: string;

    @MappedParameter(MappedParameters.GitHubRepository)
    public repo: string;

    @MappedParameter(MappedParameters.GitHubRepositoryProvider)
    public providerId: string;

    @Parameter({ required: true })
    public name: string;

    @Parameter({ required: true })
    public version: string;
}

async function ignoreVersion(cli: CommandListenerInvocation<IgnoreVersionParameters>) {
    return goals.withNewIgnore(
        queryPreferences(cli.context.graphClient),
        mutateIgnores(cli.context.graphClient),
        {
            owner: cli.parameters.owner,
            repo: cli.parameters.repo,
            name: cli.parameters.name,
            version: cli.parameters.version,
        },
    ).then(v => {
        if (v) {
            return cli.addressChannels(`now ignoring ${cli.parameters.name}/${cli.parameters.version}`);
        } else {
            return cli.addressChannels("failed to update ignore");
        }
    });
}

export const IgnoreVersion: CommandHandlerRegistration<IgnoreVersionParameters> = {
    name: "LibraryImpactIgnoreVersion",
    description: "Allow a Project to skip one version of library goal",
    paramsMaker: IgnoreVersionParameters,
    listener: async cli => ignoreVersion(cli),
};

// -------------------------------------
// set library target
// -------------------------------------

function askAboutBroadcast(cli: CommandListenerInvocation, name: string, version: string, fp: string) {
    const author = cli.context.source.slack.user.id;
    return cli.addressChannels(
        {
            attachments:
                [{
                    author_name: "Broadcast Library Target",
                    author_icon: `https://images.atomist.com/rug/warning-yellow.png`,
                    text: `Shall we nudge everyone with a PR for ${codeLine(`${name}:${version}`)}?`,
                    fallback: `Boardcast PR for ${name}:${version}`,
                    color: "#ffcc00",
                    mrkdwn_in: ["text"],
                    actions: [
                        actionableButton(
                            {
                                text: "Broadcast",
                            },
                            BroadcastNudge,
                            { name, version, author, fp},
                        ),
                    ],
                    footer: footer(),
                }],
        },
    );
}

@Parameters()
export class SetTeamLibraryGoalParameters {

    @Parameter({ required: false, displayable: false })
    public msgId?: string;

    @Parameter({ required: true })
    public name: string;

    @Parameter({ required: true })
    public version: string;

    @Parameter({ required: true })
    public fp: string;
}

async function setTeamLibraryGoal(cli: CommandListenerInvocation<SetTeamLibraryGoalParameters>) {
    // TODO with promise
    await goals.withNewGoal(
        queryPreferences(cli.context.graphClient),
        mutatePreference(cli.context.graphClient),
        {
            name: cli.parameters.name,
            version: cli.parameters.version,
        },
    );
    return askAboutBroadcast(cli, cli.parameters.name, cli.parameters.version, cli.parameters.fp);
}

export const SetTeamLibrary: CommandHandlerRegistration<SetTeamLibraryGoalParameters> = {
    name: "LibraryImpactSetTeamLibrary",
    intent: "set library target",
    description: "set a new target for a team to consume a particular version",
    paramsMaker: SetTeamLibraryGoalParameters,
    listener: async cli => setTeamLibraryGoal(cli),
};

// -------------------------------------
// set library goal from current project
// -------------------------------------

export interface ChooseTeamLibraryGoalParameters {

    msgId?: string;
    library: string;
    fp: string;
}

async function chooseTeamLibraryGoal(cli: CommandListenerInvocation<ChooseTeamLibraryGoalParameters>) {
    // TODO with promise
    await goals.withNewGoal(
        queryPreferences(cli.context.graphClient),
        mutatePreference(cli.context.graphClient),
        cli.parameters.library,
    );
    const args: string[] = cli.parameters.library.split(":");
    return askAboutBroadcast(cli, args[0], args[1], args[2]);
}

export const ChooseTeamLibrary: CommandHandlerRegistration<ChooseTeamLibraryGoalParameters> = {
    name: "LibraryImpactChooseTeamLibrary",
    description: "set library target using version in current project",
    parameters: {
        msgId: { required: false, displayable: false },
        library: {},
        fp: { required: true, displayable: false},
    },
    listener: chooseTeamLibraryGoal,
};

// ------------------------------
// update a project dependency
// ------------------------------

@Parameters()
export class ConfirmUpdateParameters {

    @Parameter({ required: false, displayable: false })
    public msgId?: string;

    @MappedParameter(MappedParameters.GitHubOwner)
    public owner: string;

    @MappedParameter(MappedParameters.GitHubRepository)
    public repo: string;

    @MappedParameter(MappedParameters.GitHubRepositoryProvider)
    public providerId: string;

    @Parameter({ required: true })
    public name: string;

    @Parameter({ required: true })
    public version: string;
}

const confirmUpdate: CodeTransform<ConfirmUpdateParameters> = async (p, cli) => {
    // await cli.addressChannels(`make an edit to the project in ${(p as GitProject).baseDir} to go to version ${cli.parameters.version}`);
    goals.edit((p as GitProject).baseDir, cli.parameters.name, cli.parameters.version);
    const message: SlackMessage = {
        attachments: [
            {
                author_name: "Library Update",
                author_icon: `https://images.atomist.com/rug/check-circle.gif?gif=${guid()}`,
                text: `Updating version to \`${cli.parameters.name}:${cli.parameters.version}\` in <https://github.com/${
                    cli.parameters.owner}/${cli.parameters.repo}|${cli.parameters.owner}/${cli.parameters.repo}>`,
                mrkdwn_in: ["text"],
                color: "#45B254",
                fallback: "none",
                footer: footer(),
            },
        ],
    };
    await cli.addressChannels(message);
    return p;
};

export const ConfirmUpdate: CodeTransformRegistration<ConfirmUpdateParameters> = {
    name: "LibraryImpactConfirmUpdate",
    description: "choose to raise a PR on the current project for a library version update",
    paramsMaker: ConfirmUpdateParameters,
    transformPresentation: ci => {
        const pr = new PullRequest(
            `library-impact-confirm-update-${Date.now()}`,
            `Update library ${ci.parameters.name} to ${ci.parameters.version}`,
            "Nudge generated by Atomist");
        (pr as any).autoMerge = {
            mode: AutoMergeMode.SuccessfulCheck,
        };
        return pr;
    },
    transform: confirmUpdate,
};

// ------------------------------
// show targets
// ------------------------------

const showTargets = async (cli: CommandListenerInvocation<NoParameters>) => {

    const sendMessage = (options: Array<{ text: string, value: string }>): Promise<void> => {
        const c: string = goals.renderOptions(options);
        logger.info(`content ${c}`);
        const message: SlackFileMessage = {
            content: c,
            fileType: "text",
            title: `Library Targets`,
        };
        return cli.addressChannels(message as SlackMessage);
    };

    return goals.withPreferences(
        queryPreferences(cli.context.graphClient),
        sendMessage,
    );
};

export const ShowTargets: CommandHandlerRegistration<NoParameters> = {
    name: "ShowTargets",
    description: "show the current targets",
    intent: "show targets",
    listener: showTargets,
};

// ------------------------------
// show goals
// ------------------------------

@Parameters()
export class ShowGoalsParameters {

    @MappedParameter(MappedParameters.GitHubOwner)
    public owner: string;

    @MappedParameter(MappedParameters.GitHubRepository)
    public repo: string;

    @MappedParameter(MappedParameters.GitHubRepositoryProvider)
    public providerId: string;

    @Secret("github://user_token?scopes=repo")
    public userToken: string;
}

const showGoals: CodeInspection<boolean, ShowGoalsParameters> = async (p, cli) => {

    const sendMessage = (text: string, options: Array<{ text: string, value: string }>): Promise<void> => {
        const message: SlackMessage = {
            attachments: [
                {
                    author_name: "Library Targets",
                    text,
                    color: "#00a5ff",
                    fallback: "Library Targets",
                    mrkdwn_in: ["text"],
                    actions: [
                        menuForCommand(
                            {
                                text: "Add a new target ...",
                                options,
                            },
                            ChooseTeamLibrary.name,
                            "library",
                            ),
                    ],
                    footer: footer(),
                },
            ],
        };
        return cli.addressChannels(message);
    };

    return goals.withProjectGoals(
        queryPreferences(cli.context.graphClient),
        (p as GitProject).baseDir,
        sendMessage,
    );
};

export const ShowGoals: CodeInspectionRegistration<boolean, ShowGoalsParameters> = {
    name: "LibraryImpactShowGoals",
    description: "show the current goals for this team",
    intent: "get library targets",
    paramsMaker: ShowGoalsParameters,
    inspection: showGoals,
};

// ------------------------------
// broadcast nudge
// ------------------------------

export interface BroadcastNudgeParameters {
    name: string;
    version: string;
    reason: string;
    author: string;
    fp: string;
}

function broadcastNudge(cli: CommandListenerInvocation<BroadcastNudgeParameters>): Promise<any> {
    const msgId = `broadcastNudge-${cli.parameters.name}-${cli.parameters.version}`;
    return goals.broadcast(
        queryFingerprints(cli.context.graphClient),
        {
            name: cli.parameters.name,
            version: cli.parameters.version,
            fp: cli.parameters.fp,
        },
        (owner: string, repo: string, channel: string) => {
            const message: SlackMessage = {
                attachments: [
                    {
                        author_name: "Library Update",
                        author_icon: `https://images.atomist.com/rug/warning-yellow.png`,
                        text: `${user(cli.parameters.author)} has updated the target version of \`${cli.parameters.name}\`.

The reason provided is:

${italic(cli.parameters.reason)}`,
                        fallback: "Library Update",
                        mrkdwn_in: ["text"],
                        color: "#ffcc00",
                    },
                    {
                        text: `Shall we update library \`${cli.parameters.name}\` to ${bold(cli.parameters.version)}?`,
                        fallback: "none",
                        actions: [
                            actionableButton(
                                {
                                    text: "Raise PR",
                                },
                                ConfirmUpdate,
                                {
                                    msgId,
                                    name: cli.parameters.name,
                                    version: cli.parameters.version,
                                },
                            ),
                        ],
                        color: "#ffcc00",
                        footer: footer(),
                        callback_id: "atm-confirm-done",
                    },
                ],
            };
            return cli.context.messageClient.addressChannels(message, channel, {id: msgId});
        },
    );
}

export const BroadcastNudge: CommandHandlerRegistration<BroadcastNudgeParameters> = {
    name: "BroadcastNudge",
    description: "message all Channels linked to Repos that contain a library",
    parameters: {
        name: { required: true },
        version: { required: true },
        fp: { required: false,
              description: "npm-project-deps, maven-project-deps, or clojure-project-deps"},
        reason: {
            required: true,
            description: "always give a reason why we're releasing the nudge",
        },
        author: {
            required: true,
            description: "author of the Nudge",
        },
    },
    listener: broadcastNudge,
};

// ------------------------------
// clear library targets
// ------------------------------

export const ClearLibraryTargets: CommandHandlerRegistration = {
    name: "ClearLibraryTargets",
    description: "reset all library targets for this team",
    intent: "clear library targets",
    listener: async cli => {
        const mutatePreferenceUpdate = mutatePreference(cli.context.graphClient);
        return queryChatTeamById(cli.context.graphClient, cli.context.workspaceId).then(
            chatTeamId => {
                return mutatePreferenceUpdate(chatTeamId, "{}");
            },
        ).then(
            result => {
                return cli.addressChannels("successfully cleaned preferences");
            },
        ).catch(
            error => {
                return cli.addressChannels(`unable to clear library targets  ${error}`);
            },
        );
    },
};

// ----------
// show prefs
// ----------

export const DumpLibraryPreferences: CommandHandlerRegistration = {
    name: "DumpLibraryPreferences",
    description: "dump current prefs into a JSON file",
    intent: "dump preferences",
    listener: async cli => {
        const query = queryPreferences(cli.context.graphClient);
        return query()
        .then(
            result => {
                const message: SlackFileMessage = {
                    title: "library prefs",
                    content: goals.renderData(result),
                    fileType: "text",
                };
                return cli.addressChannels(message);
            },
        ).catch(
            error => {
                return cli.addressChannels(`unable to fetch preferences ${error}`);
            },
        );
    },
};

export interface UseLatestParameters {
    name: string;
    version: string;
}

export const UseLatest: CommandHandlerRegistration<UseLatestParameters> = {
    name: "UseLatestLibrary",
    description: "use the latest library",
    intent: "use latest",
    parameters: {
        name: {required: true},
    },
    listener: async cli => {
        const latest: string = await goals.npmLatest(cli.parameters.name);
        const message: SlackMessage = {
            attachments: [
                {
                    text: `Shall we update library \`${cli.parameters.name}\` to ${bold(latest)}?`,
                    fallback: "none",
                    actions: [
                        actionableButton(
                            {
                                text: "Set Target",
                            },
                            SetTeamLibrary,
                            {
                                name: cli.parameters.name,
                                version: latest,
                                fp: "npm-project-deps",
                            },
                        ),
                    ],
                    color: "#ffcc00",
                    footer: footer(),
                    callback_id: "atm-confirm-done",
                },
            ],
        };
        return cli.addressChannels(message);
    },
};

export function setNewTarget(ctx: HandlerContext, name: string, version: string, channel: string) {
    const message: SlackMessage = {
        attachments: [
            {
                text: `Shall we update library target of \`${name}\` to ${version}?`,
                fallback: "none",
                actions: [
                    actionableButton(
                        {
                            text: "Set Target",
                        },
                        SetTeamLibrary,
                        {
                            name,
                            version,
                            fp: "npm-project-deps",
                        },
                    ),
                ],
                color: "#ffcc00",
                footer: footer(),
                callback_id: "atm-confirm-done",
            },
        ],
    };
    return ctx.messageClient.addressChannels(message, channel);
}
