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
    GraphQL,
    NoParameters,
    SuccessPromise,
} from "@atomist/automation-client";
import { EventHandlerRegistration } from "@atomist/sdm";
import { PullRequestImpactEvent } from "../../typings/types";

export const PullRequestImpactHandlerRegistration: EventHandlerRegistration<PullRequestImpactEvent.Subscription, NoParameters> = {
    name: "PullReqestImpactHandler",
    description: "register pull request impact handling events",
    subscription: GraphQL.subscription("PullRequestImpactEvent"),
    listener: async (event, ctx) => {
        return SuccessPromise;
    },
};
