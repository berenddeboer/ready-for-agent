Feature: View the work pipeline
  Operators use the dedicated Kanban route to monitor delivery without
  repository management competing with the pipeline.

  Scenario: View the empty work pipeline
    When I navigate to the Kanban board
    Then all six pipeline lane headers are visible
    And the Pipeline jobs tab is active
    And repository management is not rendered
    And the committed pull request totals are visible above the board
