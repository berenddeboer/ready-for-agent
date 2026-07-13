export default {
    "scalars": [
        1,
        2,
        4,
        6,
        8
    ],
    "types": {
        "Query": {
            "health": [
                1
            ],
            "repositories": [
                5
            ],
            "config": [
                3
            ],
            "issues": [
                7,
                {
                    "repositoryId": [
                        2,
                        "ID!"
                    ]
                }
            ],
            "__typename": [
                4
            ]
        },
        "Boolean": {},
        "ID": {},
        "Config": {
            "defaultModel": [
                4
            ],
            "defaultVariant": [
                4
            ],
            "__typename": [
                4
            ]
        },
        "String": {},
        "Repository": {
            "id": [
                2
            ],
            "githubOwner": [
                4
            ],
            "githubRepo": [
                4
            ],
            "localPath": [
                4
            ],
            "isBare": [
                1
            ],
            "paused": [
                1
            ],
            "issuesReconciledAt": [
                4
            ],
            "__typename": [
                4
            ]
        },
        "IssueState": {},
        "Issue": {
            "id": [
                2
            ],
            "repositoryId": [
                2
            ],
            "githubIssueNumber": [
                8
            ],
            "title": [
                4
            ],
            "body": [
                4
            ],
            "url": [
                4
            ],
            "state": [
                6
            ],
            "githubCreatedAt": [
                4
            ],
            "__typename": [
                4
            ]
        },
        "Int": {},
        "RepositoryRefresh": {
            "fetched": [
                8
            ],
            "inserted": [
                8
            ],
            "updated": [
                8
            ],
            "deleted": [
                8
            ],
            "unchanged": [
                8
            ],
            "__typename": [
                4
            ]
        },
        "AddRepositoryInput": {
            "githubOwner": [
                4
            ],
            "githubRepo": [
                4
            ],
            "localPath": [
                4
            ],
            "isBare": [
                1
            ],
            "__typename": [
                4
            ]
        },
        "UpdateConfigInput": {
            "defaultModel": [
                4
            ],
            "defaultVariant": [
                4
            ],
            "__typename": [
                4
            ]
        },
        "Mutation": {
            "addRepository": [
                5,
                {
                    "input": [
                        10,
                        "AddRepositoryInput!"
                    ]
                }
            ],
            "refreshRepository": [
                9,
                {
                    "repositoryId": [
                        2,
                        "ID!"
                    ]
                }
            ],
            "updateConfig": [
                3,
                {
                    "input": [
                        11,
                        "UpdateConfigInput!"
                    ]
                }
            ],
            "__typename": [
                4
            ]
        }
    }
}