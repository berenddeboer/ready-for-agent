export default {
    "scalars": [
        1,
        3,
        4,
        6
    ],
    "types": {
        "Query": {
            "health": [
                1
            ],
            "repositories": [
                2
            ],
            "__typename": [
                4
            ]
        },
        "Boolean": {},
        "Repository": {
            "id": [
                3
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
            "__typename": [
                4
            ]
        },
        "ID": {},
        "String": {},
        "RepositoryRefresh": {
            "fetched": [
                6
            ],
            "inserted": [
                6
            ],
            "updated": [
                6
            ],
            "deleted": [
                6
            ],
            "unchanged": [
                6
            ],
            "__typename": [
                4
            ]
        },
        "Int": {},
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
        "Mutation": {
            "addRepository": [
                2,
                {
                    "input": [
                        7,
                        "AddRepositoryInput!"
                    ]
                }
            ],
            "refreshRepository": [
                5,
                {
                    "repositoryId": [
                        3,
                        "ID!"
                    ]
                }
            ],
            "__typename": [
                4
            ]
        }
    }
}