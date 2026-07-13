export default {
    "scalars": [
        1,
        2,
        3,
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
                4
            ],
            "models": [
                2
            ],
            "issues": [
                7,
                {
                    "repositoryId": [
                        3,
                        "ID!"
                    ]
                }
            ],
            "__typename": [
                2
            ]
        },
        "Boolean": {},
        "String": {},
        "ID": {},
        "Config": {
            "defaultModel": [
                2
            ],
            "defaultVariant": [
                2
            ],
            "__typename": [
                2
            ]
        },
        "Repository": {
            "id": [
                3
            ],
            "githubOwner": [
                2
            ],
            "githubRepo": [
                2
            ],
            "localPath": [
                2
            ],
            "isBare": [
                1
            ],
            "paused": [
                1
            ],
            "issuesReconciledAt": [
                2
            ],
            "__typename": [
                2
            ]
        },
        "IssueState": {},
        "Issue": {
            "id": [
                3
            ],
            "repositoryId": [
                3
            ],
            "githubIssueNumber": [
                8
            ],
            "title": [
                2
            ],
            "body": [
                2
            ],
            "url": [
                2
            ],
            "state": [
                6
            ],
            "githubCreatedAt": [
                2
            ],
            "__typename": [
                2
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
                2
            ]
        },
        "AddRepositoryInput": {
            "githubOwner": [
                2
            ],
            "githubRepo": [
                2
            ],
            "localPath": [
                2
            ],
            "isBare": [
                1
            ],
            "__typename": [
                2
            ]
        },
        "UpdateConfigInput": {
            "defaultModel": [
                2
            ],
            "defaultVariant": [
                2
            ],
            "__typename": [
                2
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
                        3,
                        "ID!"
                    ]
                }
            ],
            "updateConfig": [
                4,
                {
                    "input": [
                        11,
                        "UpdateConfigInput!"
                    ]
                }
            ],
            "__typename": [
                2
            ]
        }
    }
}