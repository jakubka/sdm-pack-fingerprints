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

import { GraphClient, QueryNoCacheOptions } from "@atomist/automation-client";
import { ChatTeamById, FindLinkedReposWithFingerprint, GetFingerprintBySha } from "../typings/types";

export const queryChatTeamById = async (graphClient: GraphClient, teamid: string): Promise<string> => {
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

export function queryFingerprintBySha(graphClient: GraphClient): (name: string, sha: string) => Promise<any> {
    return async (name, sha) => {
        return graphClient.query<GetFingerprintBySha.Query, GetFingerprintBySha.Variables>(
            {
                name: "get-fingerprint-by-sha",
                options: QueryNoCacheOptions,
                variables: {
                    name,
                    sha,
                },
            },
        );
    };
}
