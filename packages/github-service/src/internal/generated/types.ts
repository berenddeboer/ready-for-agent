export default {
    "scalars": [
        0,
        1,
        3,
        5,
        8,
        10
    ],
    "types": {
        "DateTime": {},
        "URI": {},
        "Query": {
            "repository": [
                4,
                {
                    "owner": [
                        3,
                        "String!"
                    ],
                    "name": [
                        3,
                        "String!"
                    ]
                }
            ],
            "__typename": [
                3
            ]
        },
        "String": {},
        "Repository": {
            "issues": [
                6,
                {
                    "first": [
                        5
                    ],
                    "after": [
                        3
                    ],
                    "labels": [
                        3,
                        "[String!]"
                    ]
                }
            ],
            "__typename": [
                3
            ]
        },
        "Int": {},
        "IssueConnection": {
            "nodes": [
                9
            ],
            "pageInfo": [
                7
            ],
            "__typename": [
                3
            ]
        },
        "PageInfo": {
            "endCursor": [
                3
            ],
            "hasNextPage": [
                8
            ],
            "__typename": [
                3
            ]
        },
        "Boolean": {},
        "Issue": {
            "number": [
                5
            ],
            "title": [
                3
            ],
            "body": [
                3
            ],
            "url": [
                1
            ],
            "createdAt": [
                0
            ],
            "state": [
                10
            ],
            "__typename": [
                3
            ]
        },
        "IssueState": {}
    }
}